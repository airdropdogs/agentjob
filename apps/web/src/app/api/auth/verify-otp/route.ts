import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'
import { writeAuditLog, getClientIp } from '@/lib/audit'

const schema = z.object({
  flowId: z.string().min(1),
  otp: z.string().length(6),
})

/** POST verify-otp — CDP email verify; upsert user; session */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return err('Invalid request', 400)
  }

  const session = await getSession()
  const { flowId, otp } = parsed.data

  if (!session.pendingEmail || !session.pendingFlowId) {
    return err('No pending OTP flow. Please request OTP first.', 400)
  }

  if (session.pendingFlowId !== flowId) {
    return err('Flow ID mismatch', 400)
  }

  try {
    // CDP SDK: verifyEmailOTP
    const cdpResp = await fetch('https://api.cdp.coinbase.com/platform/v2/auth/email/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDP-Project-Id': process.env.CDP_PROJECT_ID!,
      },
      body: JSON.stringify({ flow_id: flowId, otp }),
    })

    if (!cdpResp.ok) {
      return err('Invalid OTP or expired', 400)
    }

    const { wallet_address: walletAddress } = await cdpResp.json()
    const email = session.pendingEmail

    // Upsert user
    const db = getDb()
    let user = await db.query.users.findFirst({ where: eq(users.email, email) })

    if (!user) {
      const [newUser] = await db
        .insert(users)
        .values({
          email,
          wallet: walletAddress ?? null,
          emailVerifiedAt: new Date(),
        })
        .returning()
      user = newUser
    } else if (!user.emailVerifiedAt) {
      // Rare: existed unverified
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date(), wallet: walletAddress ?? user.wallet })
        .where(eq(users.id, user.id))
      user = { ...user, emailVerifiedAt: new Date() }
    }

    if (user.bannedAt) {
      return err('Account is banned', 403)
    }

    // ADMIN_EMAILS → promote to admin
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)

    if (adminEmails.includes(email.toLowerCase()) && user.role !== 'admin') {
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id))
      user = { ...user, role: 'admin' }
    }

    // Audit log
    writeAuditLog({
      userId: user.id,
      action: 'login',
      targetType: 'user',
      targetId: user.id,
      metadata: { email: user.email, role: user.role },
      ipAddress: getClientIp(req),
    })

    // Session
    session.userId = user.id
    session.email = user.email
    session.role = user.role
    session.wallet = user.wallet ?? undefined
    session.pendingEmail = undefined
    session.pendingFlowId = undefined
    await session.save()

    return ok({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        wallet: user.wallet,
        emailVerifiedAt: user.emailVerifiedAt,
      },
    })
  } catch (e) {
    console.error('[auth/verify-otp]', e)
    return err('Internal error', 500)
  }
}
