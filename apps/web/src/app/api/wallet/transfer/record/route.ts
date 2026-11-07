import { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { ok, err, unauthorized } from '@/lib/api-response'
import { getDb } from '@/lib/db'
import { users, userWalletSettings } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { getPlatformConfig } from '@/lib/platform-config'
import { z } from 'zod'

const schema = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string(),
  userOpHash: z.string().optional(),
})

/** POST /api/wallet/transfer/record — after on-chain transfer; atomic cooldown write */
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return unauthorized()

  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return err('Invalid request', 400)

  const { to, amount, userOpHash } = parsed.data

  const db = getDb()
  const user = await db.query.users.findFirst({
    columns: { wallet: true, bannedAt: true },
    where: eq(users.id, session.userId),
  })
  if (!user || user.bannedAt) return unauthorized()

  const config = await getPlatformConfig()

  // Re-check cooldown (bypass validate)
  const settings = await db.query.userWalletSettings.findFirst({
    where: eq(userWalletSettings.userId, session.userId),
  })

  if (settings?.lastUsdcTransferAt) {
    const msPerDay = 86_400_000
    const nextAvailable = new Date(
      settings.lastUsdcTransferAt.getTime() + config.walletTransferCooldownDays * msPerDay
    )
    if (nextAvailable > new Date()) {
      return err('Transfer cooldown active', 429)
    }
  }

  const now = new Date()

  // upsert user_wallet_settings
  await db
    .insert(userWalletSettings)
    .values({ userId: session.userId, lastUsdcTransferAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: userWalletSettings.userId,
      set: { lastUsdcTransferAt: now, updatedAt: now },
    })

  const cooldownDays = config.walletTransferCooldownDays
  const nextTransferAt = new Date(now.getTime() + cooldownDays * 86_400_000)

  console.log('[wallet/transfer/record]', {
    userId: session.userId,
    smartWallet: user.wallet,
    to,
    amount,
    userOpHash: userOpHash ?? null,
  })

  return ok({ recorded: true, nextTransferAt: nextTransferAt.toISOString() })
}
