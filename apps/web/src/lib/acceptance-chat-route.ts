import type { NextRequest } from 'next/server'
import type { SessionData } from './session'
import { createChatPaymentAcceptance, type AcceptanceIntent, type AcceptanceStage } from './chat-payment-acceptance'
import { extractPaymentHeader, verifyAcceptancePayment, settleAcceptancePayment } from './x402'

const ledger = createChatPaymentAcceptance()
export const getChatPaymentIntent = ledger.get
const json = (body: unknown, status = 200) => Response.json(body, { status })
const pending = (intent: AcceptanceIntent) => json({ chat_id: intent.chatId, task_id: intent.taskId, status: 'pending', is_free: false }, 202)

export async function acceptanceChat(input: {
  req: NextRequest; session: SessionData; agentId: string; chatId: string; key: string | null
  messages: Array<{role: string; content: string; attachments?: import('./attachment-policy').ChatAttachment[]}>; stage: AcceptanceStage
  totalUsdc: string; feeRate: number; agentWallet: string | null; online: boolean
}) {
  const { req, session, agentId, chatId, key, messages, stage } = input
  if (!session.cdpVerified) return json({ error: 'Please sign in again before payment.', code: 'verified_login_required' }, 401)
  if (!key) return json({ error: 'A stable Idempotency-Key is required.', code: 'idempotency_required' }, 400)
  const previous = await ledger.get({ userId: session.userId, idempotencyKey: key })
  if (!previous && process.env.ENABLE_CHAT_PAYMENT_ACCEPTANCE !== 'true') return json({ error: 'Paid requests are temporarily unavailable', code: 'payments_disabled' }, 503)
  const totalMicro = Math.round(Number(input.totalUsdc) * 1_000_000)
  const intent = await ledger.prepare({
    userId: session.userId, agentId, chatId, idempotencyKey: key, messages,
    payer: session.wallet ?? '',
    platformRecipient: previous?.platformRecipient ?? process.env.CHAT_PAYMENT_ACCEPTANCE_PLATFORM_WALLET ?? '',
    agentRecipient: previous?.agentRecipient ?? process.env.CHAT_PAYMENT_ACCEPTANCE_AGENT_WALLET ?? input.agentWallet ?? '',
    totalMicro, platformFeeMicro: Math.round(totalMicro * input.feeRate),
  })
  if (intent.taskId) return pending(intent)
  // Delivery is recoverable without charging again, including after a database/network failure.
  if (intent.agentStatus === 'settled') return deliver(intent, messages)
  const status = stage === 'platform_fee' ? intent.platformStatus : intent.agentStatus
  if (status === 'settled') return json({ ok: true, chat_id: chatId, tx: intent.receipts.find(r => r.stage === stage)?.transaction })
  if (status === 'uncertain' || status === 'settling' || status === 'processing') {
    return json({ error: 'Payment is being checked. Do not start a new payment; retry this message later.', code: 'payment_reconciliation_required' }, 409)
  }
  if (!input.online) return json({ error: 'Agent is offline. Keep this message and retry when online.', code: 'agent_offline' }, 503)
  if (stage === 'agent' && intent.platformStatus !== 'settled') return json({ error: 'Confirm the platform fee first.', code: 'platform_fee_required' }, 409)
  if (process.env.ENABLE_CHAT_PAYMENT_ACCEPTANCE !== 'true') return json({ error: 'Paid requests are temporarily unavailable', code: 'payments_disabled' }, 503)
  const amount = stage === 'platform_fee' ? intent.platformFeeMicro : intent.agentMicro
  const recipient = stage === 'platform_fee' ? intent.platformRecipient : intent.agentRecipient
  const requirements = {
    scheme: 'exact' as const, network: 'base', maxAmountRequired: String(amount), resource: req.url,
    description: stage === 'platform_fee' ? 'AgentJob platform fee' : 'AgentJob agent payment',
    mimeType: 'application/json', payTo: recipient, maxTimeoutSeconds: 300,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' },
  }
  const paymentHeader = extractPaymentHeader(req)
  if (!paymentHeader) return json({ x402Version: 1, error: 'Payment required', accepts: [requirements] }, 402)
  const payment = { paymentHeader, paymentRequirements: requirements, agentWallet: recipient, amountUsdc: amount / 1_000_000, platformFeeRate: 0 }
  const result = await ledger.executeStage({ userId: session.userId, idempotencyKey: key, stage,
    verify: () => verifyAcceptancePayment(payment, intent.payer),
    settle: () => settleAcceptancePayment(payment),
  })
  if (result.status !== 'settled') return json({
    error: result.status === 'verify_failed' ? 'Payment authorization was not verified. No settlement was attempted.' : 'Payment needs reconciliation. Do not start a new payment.',
    code: result.status === 'verify_failed' ? 'payment_verify_failed' : 'payment_reconciliation_required',
  }, result.status === 'verify_failed' ? 400 : 409)
  if (stage === 'platform_fee') return json({ ok: true, chat_id: chatId, tx: result.receipt?.transaction })
  return deliver(result.intent, messages)
}

async function deliver(intent: AcceptanceIntent, messages: Array<{role: string; content: string; attachments?: import('./attachment-policy').ChatAttachment[]}>) {
  const delivered = await ledger.finalize({ userId: intent.userId, idempotencyKey: intent.idempotencyKey }, async (client, current) => {
    const existing = await client.query('SELECT user_id,agent_id FROM chats WHERE id=$1 FOR UPDATE', [current.chatId])
    if (existing.rows[0] && (existing.rows[0].user_id !== current.userId || existing.rows[0].agent_id !== current.agentId)) throw new Error('Chat ownership conflict')
    await client.query(`INSERT INTO chats(id,user_id,agent_id,is_first_chat,total_messages,total_spent,last_message_at)
      VALUES($1,$2,$3,0,1,$4,now()) ON CONFLICT(id) DO UPDATE SET total_messages=chats.total_messages+1,total_spent=chats.total_spent+$4,last_message_at=now()`,
    [current.chatId, current.userId, current.agentId, String(current.totalMicro / 1_000_000)])
    await client.query(`INSERT INTO payments(chat_id,payer_id,amount_platform,amount_agent,tx_platform,tx_agent,x402_payment_id,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'success')`, [current.chatId, current.userId, String(current.platformFeeMicro / 1_000_000), String(current.agentMicro / 1_000_000),
      current.receipts.find(r => r.stage === 'platform_fee')?.transaction ?? null, current.receipts.find(r => r.stage === 'agent')!.transaction, current.id])
    await client.query("INSERT INTO messages(chat_id,role,content,attachments) VALUES($1,'user',$2,$3)", [current.chatId, messages[messages.length - 1].content, JSON.stringify(messages[messages.length - 1].attachments ?? [])])
    const task = await client.query(`INSERT INTO agent_chat_tasks(agent_id,chat_id,user_id,messages,is_first_chat,amount_usdc,status)
      VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING id`, [current.agentId, current.chatId, current.userId, JSON.stringify(messages), !existing.rowCount, String(current.totalMicro / 1_000_000)])
    return { taskId: task.rows[0].id }
  })
  return pending(delivered)
}
