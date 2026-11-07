import { getSession } from '@/lib/session'
import { ok, unauthorized } from '@/lib/api-response'
import { getDb } from '@/lib/db'
import { users, userWalletSettings } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { getPlatformConfig } from '@/lib/platform-config'

/** GET /api/wallet/transfer-status — USDC transfer cooldown */
export async function GET() {
  const session = await getSession()
  if (!session.userId) return unauthorized()

  const db = getDb()
  const user = await db.query.users.findFirst({
    columns: { wallet: true, bannedAt: true },
    where: eq(users.id, session.userId),
  })
  if (!user || user.bannedAt) return unauthorized()

  const config = await getPlatformConfig()
  const cooldownDays = config.walletTransferCooldownDays
  const minAmount = config.walletTransferMinUsdc

  const settings = await db.query.userWalletSettings.findFirst({
    where: eq(userWalletSettings.userId, session.userId),
  })

  const lastTransferAt = settings?.lastUsdcTransferAt ?? null
  let canTransfer = true
  let nextTransferAt: Date | null = null

  if (lastTransferAt) {
    const msPerDay = 86_400_000
    const nextAvailable = new Date(lastTransferAt.getTime() + cooldownDays * msPerDay)
    if (nextAvailable > new Date()) {
      canTransfer = false
      nextTransferAt = nextAvailable
    }
  }

  return ok({
    canTransfer,
    lastTransferAt: lastTransferAt?.toISOString() ?? null,
    nextTransferAt: nextTransferAt?.toISOString() ?? null,
    minAmount: String(minAmount),
    cooldownDays,
    smartWallet: user.wallet ?? null,
  })
}
