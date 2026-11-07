import { ok, err } from '@/lib/api-response'
import { getSession } from '@/lib/session'
import { getPlatformConfig } from '@/lib/platform-config'
import { getServerWalletDailyCount } from '@/lib/rate-limit'

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * GET /api/register/auto/quota
 * Admin-only: returns today's Server Wallet registration quota usage.
 */
export async function GET() {
  const session = await getSession()
  if (!session.userId) return err('Unauthorized', 401)
  if (session.role !== 'admin') return err('Forbidden', 403)

  const today = todayUTC()
  const [config, used] = await Promise.all([
    getPlatformConfig(),
    getServerWalletDailyCount(today),
  ])

  return ok({
    date: today,
    used,
    limit: config.serverWalletDailyLimit,
    remaining: Math.max(0, config.serverWalletDailyLimit - used),
    enabled: config.serverWalletEnabled,
  })
}
