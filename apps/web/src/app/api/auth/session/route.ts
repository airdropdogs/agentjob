import { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq, and, isNull } from 'drizzle-orm'
import { verifyCdpIdentity } from '@/lib/cdp-auth'
import { ok, err, unauthorized } from '@/lib/api-response'

/** GET /api/auth/session — sync role/wallet from DB into session */
export async function GET() {
  const session = await getSession()
  if (!session.userId) {
    return unauthorized()
  }
  const db = getDb()
  const user = await db.query.users.findFirst({
    columns: { role: true, wallet: true, bannedAt: true },
    where: eq(users.id, session.userId),
  })
  if (!user) {
    return unauthorized()
  }
  if (user.bannedAt) {
    return unauthorized()
  }
  // DB is source of truth for role (admin access)
  const role = user.role as 'user' | 'admin'
  const wallet = user.wallet ?? session.wallet
  let changed = false
  if (session.role !== role) {
    session.role = role
    changed = true
  }
  if (wallet !== session.wallet) {
    session.wallet = wallet
    changed = true
  }
  if (changed) await session.save()
  return ok({
    userId: session.userId,
    email: session.email,
    role,
    cdpVerified: session.cdpVerified === true,
    wallet: wallet ?? session.wallet,
  })
}

/** PATCH wallet — backfill from CDP hooks { wallet: "0x..." } */
export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return unauthorized()

  const body = await req.json().catch(() => null)
  const wallet = body?.wallet as string | undefined
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return err('Invalid wallet address', 400)
  }

  const db = getDb()
  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) })
  if (!user || user.bannedAt) return unauthorized()
  let identity
  try {
    identity = await verifyCdpIdentity(req, user.email, wallet)
  } catch {
    return unauthorized()
  }
  if (user.wallet && user.wallet.toLowerCase() !== wallet.toLowerCase()) {
    return err('Existing wallet cannot be replaced', 409)
  }
  const changed = await db.update(users).set({ wallet: identity.wallet })
    .where(and(eq(users.id, session.userId), isNull(users.wallet))).returning({ wallet: users.wallet })
  // Another verified request may have bound a wallet while this request was in flight.
  const current = changed[0] ?? await db.query.users.findFirst({ where: eq(users.id, session.userId), columns: { wallet: true } })
  if (current?.wallet?.toLowerCase() !== wallet.toLowerCase()) return err('Existing wallet cannot be replaced', 409)

  session.wallet = current.wallet
  session.cdpVerified = true
  session.cdpUserId = identity.userId
  await session.save()

  return ok({ wallet: current.wallet, updated: changed.length > 0 })
}
