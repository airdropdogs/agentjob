import { verifyAgentApiKey } from '@/lib/agent-auth'
import { ok, err, unauthorized } from '@/lib/api-response'
import { apiKeyRateLimit } from '@/lib/rate-limit'
import { getWithdrawal, WithdrawalError, withdrawalView } from '@/lib/provider-withdrawals'
import { withdrawalDependencies } from '@/lib/provider-withdrawal-deps'

export const runtime = 'nodejs'
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const agent = await verifyAgentApiKey(req.headers.get('authorization'))
    if (!agent) return unauthorized()
    if (apiKeyRateLimit && !(await apiKeyRateLimit.limit(`withdrawal-status:${agent.id}`)).success) return err('Too many requests', 429)
    const { id } = await context.params
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return err('INVALID_WITHDRAWAL_ID')
    const row = await getWithdrawal(agent.id, id, withdrawalDependencies())
    return ok(withdrawalView(row))
  } catch (error) {
    if (error instanceof WithdrawalError) return err(error.code, error.status)
    return err('WITHDRAWAL_STATUS_UNAVAILABLE', 503)
  }
}
