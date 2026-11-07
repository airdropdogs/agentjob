import { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { ok, err, unauthorized } from '@/lib/api-response'
import { getDb } from '@/lib/db'
import { users, userWalletSettings } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { getPlatformConfig } from '@/lib/platform-config'
import { z } from 'zod'

const schema = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Base address'),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount'),
})

/** POST /api/wallet/transfer/validate — preflight cooldown/amount/to (no DB lock) */
export async function POST(req: NextRequest) {
  if (process.env.ENABLE_REAL_PAYMENTS !== 'true') {
    return err('Transfers are temporarily unavailable', 503)
  }
  const session = await getSession()
  if (!session.userId) return unauthorized()

  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Invalid request', 400)

  const { to, amount } = parsed.data
  const amountNum = parseFloat(amount)

  const db = getDb()
  const user = await db.query.users.findFirst({
    columns: { wallet: true, bannedAt: true },
    where: eq(users.id, session.userId),
  })
  if (!user || user.bannedAt) return unauthorized()
  if (!user.wallet) return err('Wallet not ready. Send a chat message first to finish setup.', 400)

  const config = await getPlatformConfig()

  if (amountNum <= config.walletTransferMinUsdc) {
    return err(`Minimum transfer is ${config.walletTransferMinUsdc} USDC`, 400)
  }

  const settings = await db.query.userWalletSettings.findFirst({
    where: eq(userWalletSettings.userId, session.userId),
  })

  if (settings?.lastUsdcTransferAt) {
    const msPerDay = 86_400_000
    const nextAvailable = new Date(
      settings.lastUsdcTransferAt.getTime() + config.walletTransferCooldownDays * msPerDay
    )
    if (nextAvailable > new Date()) {
      const dateStr = nextAvailable.toLocaleDateString('zh-CN')
      return err(`Transfer cooldown. Next available: ${dateStr}`, 429)
    }
  }

  return ok({ valid: true, smartWallet: user.wallet, to, amount })
}
