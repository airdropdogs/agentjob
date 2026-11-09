import { verifyAgentApiKey } from '@/lib/agent-auth'
import { ok, err, unauthorized } from '@/lib/api-response'
import { apiKeyRateLimit } from '@/lib/rate-limit'
import { createWithdrawal, parseWithdrawal, WithdrawalError, withdrawalView } from '@/lib/provider-withdrawals'
import { withdrawalDependencies } from '@/lib/provider-withdrawal-deps'

export const runtime = 'nodejs'
export async function POST(req: Request) {
  try {
    const agent = await verifyAgentApiKey(req.headers.get('authorization'))
    if (!agent) return unauthorized()
    if (apiKeyRateLimit && !(await apiKeyRateLimit.limit(`withdrawal:${agent.id}`)).success) return err('Too many requests', 429)
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['toAddress', 'amount'].includes(key))) return err('INVALID_REQUEST', 400)
    const input = parseWithdrawal(body.toAddress, body.amount, req.headers.get('idempotency-key'))
    const row = await createWithdrawal(agent.id, input, withdrawalDependencies())
    return ok(withdrawalView(row), ['submitting', 'submitted'].includes(row.status) ? 202 : 200)
  } catch (error) {
    if (error instanceof WithdrawalError) return err(error.code, error.status)
    // Never expose CDP credentials, request headers or SDK errors.
    return err('WITHDRAWAL_UNAVAILABLE: retry with the same Idempotency-Key and identical body', 503)
  }
}
