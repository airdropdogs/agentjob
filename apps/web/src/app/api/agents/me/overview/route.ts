import { getDb } from '@/lib/db'
import { verifyAgentApiKey, isAgentOnlineByHeartbeat } from '@/lib/agent-auth'
import { ok, err, unauthorized } from '@/lib/api-response'
import { agentProfiles, users, chats, payments } from '@agentjob/db'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { apiKeyRateLimit } from '@/lib/rate-limit'

/** Provider-only, read-only overview. Week boundaries and ledger timestamps are UTC. */
export async function GET(req: Request) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) return unauthorized()
  if (apiKeyRateLimit) {
    try {
      if (!(await apiKeyRateLimit.limit(`apikey:${agent.id}`)).success) return err('Too many requests', 429)
    } catch { return err('Overview temporarily unavailable', 503) }
  }
  const db = getDb()
  const [owner] = await db.select({ wallet: users.wallet, bannedAt: users.bannedAt })
    .from(users).innerJoin(agentProfiles, eq(agentProfiles.userId, users.id))
    .where(eq(agentProfiles.id, agent.id)).limit(1)
  if (!owner || owner.bannedAt) return unauthorized()

  const now = new Date()
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7)
  try {
    const [[inquiries], [receipts]] = await Promise.all([
      db.select({
        users: sql<number>`count(distinct ${chats.userId})::int`,
        conversations: sql<number>`count(*)::int`,
      }).from(chats).where(and(eq(chats.agentId, agent.id), sql`${chats.totalMessages} > 0`)),
      db.select({ usdc: sql<string>`coalesce(sum(${payments.amountAgent}), 0)::text` })
        .from(payments).innerJoin(chats, eq(payments.chatId, chats.id))
        .where(and(eq(chats.agentId, agent.id), eq(payments.status, 'success'),
          gte(payments.createdAt, weekStart), lt(payments.createdAt, now))),
    ])
    let balance: { status: string; usdc: string | null } = { status: 'no_wallet', usdc: null }
    if (owner.wallet && /^0x[0-9a-f]{40}$/i.test(owner.wallet)) {
      balance = { status: 'unavailable', usdc: null }
      try {
        const response = await fetch('https://mainnet.base.org', {
          method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{
            to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            data: '0x70a08231' + owner.wallet.slice(2).toLowerCase().padStart(64, '0'),
          }, 'latest'] }),
        })
        const body = await response.json()
        if (response.ok && !body.error && /^0x[0-9a-f]+$/i.test(body.result ?? '')) {
          const raw = BigInt(body.result)
          balance = { status: 'available', usdc: `${raw / BigInt(1000000)}.${(raw % BigInt(1000000)).toString().padStart(6, '0')}` }
        }
      } catch { /* Preserve unavailable rather than reporting a zero balance. */ }
    }
    return ok({
      agentId: agent.id, name: agent.name, online: isAgentOnlineByHeartbeat(agent.lastHeartbeatAt),
      lastHeartbeatAt: agent.lastHeartbeatAt, observedAt: now.toISOString(),
      walletAddress: owner.wallet, walletBalance: balance,
      chatUrl: owner.wallet ? `https://agent-job.ai/chat/${owner.wallet}` : null,
      inquiries: { uniqueUsers: inquiries.users, conversations: inquiries.conversations, period: 'all_time', source: 'chats_with_messages' },
      week: { start: weekStart.toISOString(), end: now.toISOString(), timezone: 'UTC',
        recordedAgentReceiptsUsdc: receipts.usdc, source: 'successful_payments_by_created_at',
        note: 'Recorded Agent share; not net profit, refund-adjusted earnings, or verified deposits to this wallet. Pending and partially failed payments excluded.',
      },
    })
  } catch { return err('Overview temporarily unavailable', 503) }
}
