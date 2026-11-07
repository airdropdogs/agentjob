import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users, agentProfiles } from '@agentjob/db'
import { eq, and, isNull } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'
import { generateApiKey, hashApiKey } from '@/lib/utils'
import { verifyCdpIdentity } from '@/lib/cdp-auth'

const schema = z.object({
  email: z.string().email(),
  walletAddress: z.string().optional(),
})

/**
 * POST /api/auth/cdp-sync — after CDP OTP on client: upsert user, save session.
 * Identity and wallet ownership are verified by CDP on the server.
 */
export async function POST(req: NextRequest) {
  console.log('[cdp-sync] start')
  console.log('[cdp-sync] SESSION_SECRET set:', !!process.env.SESSION_SECRET, 'length:', process.env.SESSION_SECRET?.length)
  console.log('[cdp-sync] DATABASE_URL set:', !!process.env.DATABASE_URL)

  try {
    const body = await req.json().catch(() => null)
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      console.warn('[cdp-sync] validation failed:', parsed.error.issues)
      return err('Invalid request', 400)
    }

    let identity
    try {
      identity = await verifyCdpIdentity(req, parsed.data.email, parsed.data.walletAddress)
    } catch {
      return err('Please sign in again to verify your identity', 401)
    }
    const { email, wallet: walletAddress } = identity
    console.log('[cdp-sync] email:', email, 'wallet:', walletAddress)

    let db
    try {
      db = getDb()
    } catch (dbErr) {
      console.error('[cdp-sync] getDb() failed:', dbErr)
      return err('Database init error', 500)
    }

    let user
    let isNewUser = false
    try {
      user = await db.query.users.findFirst({ where: eq(users.email, email) })
      console.log('[cdp-sync] existing user:', user?.id ?? 'not found')
    } catch (dbErr) {
      console.error('[cdp-sync] findFirst failed:', dbErr)
      return err('Database query error', 500)
    }

    if (user?.wallet && !identity.wallets.includes(user.wallet.toLowerCase())) {
      return err('Existing wallet does not match your verified account. Contact support.', 409)
    }

    if (!user) {
      try {
        const [newUser] = await db
          .insert(users)
          .values({
            email,
            wallet: walletAddress ?? null,
            emailVerifiedAt: new Date(),
          })
          .returning()
        user = newUser
        isNewUser = true
        console.log('[cdp-sync] new user created:', user.id)
      } catch (dbErr) {
        console.error('[cdp-sync] insert user failed:', dbErr)
        return err('Failed to create user', 500)
      }
    } else {
      if (!user.wallet && walletAddress) {
        const updated = await db
          .update(users)
          .set({ wallet: walletAddress, emailVerifiedAt: user.emailVerifiedAt ?? new Date() })
          .where(and(eq(users.id, user.id), isNull(users.wallet)))
          .returning()
        const current = updated[0] ?? await db.query.users.findFirst({ where: eq(users.id, user.id) })
        if (!current || (current.wallet && !identity.wallets.includes(current.wallet.toLowerCase()))) {
          return err('Existing wallet does not match your verified account. Contact support.', 409)
        }
        user = current
      }
      if (!user.emailVerifiedAt) {
        await db
          .update(users)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(users.id, user.id))
        user = { ...user, emailVerifiedAt: new Date() }
      }
    }

    if (user.bannedAt) {
      return err('Account is banned', 403)
    }

    // New users: default agent profile + API key
    let defaultAgentApiKey: string | null = null
    if (isNewUser) {
      try {
        const apiKey = generateApiKey()
        const namePrefix = email.split('@')[0] ?? 'agent'
        await db.insert(agentProfiles).values({
          userId: user.id,
          name: `${namePrefix}'s Agent`,
          priceFirstMsg: '0.05',    // Retained for compatibility; first-message eligibility uses the free-message policy
          priceSubsequent: '0.05',
          freeDailyMax: 20,         // Default: 20 free messages per day
          dailyReplyLimit: 500,     // Default: 500 replies per day
          apiKeyHash: hashApiKey(apiKey),
          customSkillTags: [],
        })
        defaultAgentApiKey = apiKey
        console.log('[cdp-sync] default agent created for new user:', user.id)
      } catch (agentErr) {
        // Non-fatal: user can create agent in dashboard
        console.warn('[cdp-sync] default agent creation failed (non-fatal):', agentErr)
      }
    }

    let session
    try {
      session = await getSession()
      console.log('[cdp-sync] session obtained, saving...')
    } catch (sessErr) {
      console.error('[cdp-sync] getSession() failed:', sessErr)
      return err('Session error', 500)
    }

    session.userId = user.id
    session.email = user.email
    session.role = user.role as 'user' | 'admin'
    session.wallet = user.wallet ?? undefined
    session.cdpVerified = true
    session.cdpUserId = identity.userId

    try {
      await session.save()
      console.log('[cdp-sync] session saved for userId:', user.id)
    } catch (sessErr) {
      console.error('[cdp-sync] session.save() failed:', sessErr)
      return err('Session save error', 500)
    }

    console.log('[cdp-sync] success, returning user:', user.id)
    return ok({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        wallet: user.wallet,
      },
      // Shown once for new signups
      ...(defaultAgentApiKey ? { defaultAgentApiKey } : {}),
    })
  } catch (e) {
    console.error('[cdp-sync] unhandled exception:', e)
    return err('Internal server error', 500)
  }
}
