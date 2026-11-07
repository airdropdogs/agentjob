import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { getPool } from './db'
import { acceptanceMessagesHash } from './chat-payment-acceptance'
import { getFreeChatPolicy } from './free-chat-policy'
import { evaluateChatFreeEligibility } from './chat-eligibility'
import { isAgentOnlineByHeartbeat } from './agent-auth'

export class FreeChatRequestError extends Error {
  constructor(public code: string, public status: number) { super(code) }
}
const fail = (code: string, status: number): never => { throw new FreeChatRequestError(code, status) }
export type FreeChatRequestInput = {
  userId: string; agentId: string; idempotencyKey: string; requestedChatId?: string | null
  messages: Array<{ role: string; content: string; attachments?: import('./attachment-policy').ChatAttachment[] }>
}
export type ChatRequestDecision = {
  decision: 'free' | 'paid'; chatId: string; taskId: string | null
  freeMessagesRemaining: number | null; slotHint: string | null
}
type RequestRow = {
  agent_id: string; chat_id: string; messages_hash: string; decision: 'free' | 'paid'
  task_id: string | null; free_messages_remaining: number | null; slot_hint: string | null
}
function requestDecision(row: RequestRow, input: FreeChatRequestInput): ChatRequestDecision {
  if (row.agent_id !== input.agentId || (input.requestedChatId && row.chat_id !== input.requestedChatId) || row.messages_hash !== acceptanceMessagesHash(input.messages)) {
    return fail('idempotency_conflict', 409)
  }
  return { decision: row.decision, chatId: row.chat_id, taskId: row.task_id, freeMessagesRemaining: row.free_messages_remaining, slotHint: row.slot_hint }
}
async function read(client: Pool | PoolClient, input: FreeChatRequestInput) {
  const result = await client.query<RequestRow>('SELECT * FROM chat_free_requests WHERE user_id=$1 AND idempotency_key=$2', [input.userId, input.idempotencyKey])
  return result.rows[0] ? requestDecision(result.rows[0], input) : null
}
export function createFreeChatRequests(options: { pool?: Pool } = {}) {
  const pool = () => options.pool ?? getPool()
  async function get(input: FreeChatRequestInput) { return read(pool(), input) }
  async function consume(input: FreeChatRequestInput): Promise<ChatRequestDecision> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) fail('idempotency_required', 400)
    const client = await pool().connect()
    try {
      await client.query('BEGIN')
      // All consumers acquire user then agent rows. This serializes user-wide and
      // agent-wide caps, including requests for different chats and different keys.
      const user = (await client.query<{ lifetime_free_count: number; banned_at: Date | null; today: string }>("SELECT lifetime_free_count,banned_at,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS today FROM users WHERE id=$1 FOR UPDATE", [input.userId])).rows[0]
      if (!user) fail('unauthorized', 401)
      const replay = await read(client, input)
      if (replay) { await client.query('COMMIT'); return replay }
      if (user.banned_at) fail('account_unavailable', 403)
      const agent = (await client.query<{ free_daily_max: number; free_messages_per_user: number; max_concurrent_chats: number; last_heartbeat_at: Date | null; is_active: boolean }>('SELECT free_daily_max,free_messages_per_user,max_concurrent_chats,last_heartbeat_at,is_active FROM agent_profiles WHERE id=$1 FOR UPDATE', [input.agentId])).rows[0]
      if (!agent?.is_active) fail('agent_not_found', 404)
      const chatId = input.requestedChatId ?? randomUUID()
      const existingChat = (await client.query<{ user_id: string; agent_id: string }>('SELECT user_id,agent_id FROM chats WHERE id=$1 FOR UPDATE', [chatId])).rows[0]
      if (existingChat && (existingChat.user_id !== input.userId || existingChat.agent_id !== input.agentId)) fail('chat_not_found', 404)
      const used = (await client.query<{ used_count: number }>('SELECT used_count FROM user_agent_free_used WHERE user_id=$1 AND agent_id=$2', [input.userId, input.agentId])).rows[0]?.used_count ?? 0
      const agentDaily = (await client.query<{ free_users_count: number }>('SELECT free_users_count FROM agent_daily_stats WHERE agent_id=$1 AND stat_date=$2', [input.agentId, user.today])).rows[0]?.free_users_count ?? 0
      const policy = await getFreeChatPolicy(client)
      const userDaily = (await client.query<{ free_count: number }>('SELECT free_count FROM user_daily_free_stats WHERE user_id=$1 AND stat_date=$2', [input.userId, user.today])).rows[0]?.free_count ?? 0
      const eligibility = evaluateChatFreeEligibility({
        existingChat: Boolean(existingChat), userAgentUsedCount: used, freeMessagesPerUser: agent.free_messages_per_user,
        ...policy, userDailyLimit: policy.freeUserDailyLimit, userDailyUsed: userDaily,
        userExists: true, banned: false, agentUsed: agentDaily, agentLimit: agent.free_daily_max,
      })
      let taskId: string | null = null
      if (eligibility.eligible) {
        if (!isAgentOnlineByHeartbeat(agent.last_heartbeat_at)) fail('agent_offline', 503)
        const pending = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_chat_tasks WHERE agent_id=$1 AND status='pending'", [input.agentId])).rows[0].n
        if (pending >= agent.max_concurrent_chats) fail('agent_busy', 503)
        await client.query('INSERT INTO user_agent_free_used(user_id,agent_id,used_count) VALUES($1,$2,1) ON CONFLICT(user_id,agent_id) DO UPDATE SET used_count=user_agent_free_used.used_count+1', [input.userId, input.agentId])
        await client.query('INSERT INTO agent_daily_stats(agent_id,stat_date,free_users_count,total_replies) VALUES($1,$2,1,0) ON CONFLICT(agent_id,stat_date) DO UPDATE SET free_users_count=agent_daily_stats.free_users_count+1', [input.agentId, user.today])
        await client.query('INSERT INTO user_daily_free_stats(user_id,stat_date,free_count) VALUES($1,$2,1) ON CONFLICT(user_id,stat_date) DO UPDATE SET free_count=user_daily_free_stats.free_count+1', [input.userId, user.today])
        await client.query('UPDATE users SET lifetime_free_count=lifetime_free_count+1 WHERE id=$1', [input.userId])
        const chat = await client.query(`INSERT INTO chats(id,user_id,agent_id,is_first_chat,total_messages,total_spent,last_message_at)
          VALUES($1,$2,$3,0,1,0,now()) ON CONFLICT(id) DO UPDATE SET total_messages=chats.total_messages+1,last_message_at=now()
          WHERE chats.user_id=$2 AND chats.agent_id=$3 RETURNING id`, [chatId, input.userId, input.agentId])
        if (!chat.rowCount) fail('chat_not_found', 404)
        await client.query("INSERT INTO messages(chat_id,role,content,attachments) VALUES($1,'user',$2,$3)", [chatId, input.messages[input.messages.length - 1].content, JSON.stringify(input.messages[input.messages.length - 1].attachments ?? [])])
        taskId = (await client.query<{ id: string }>(`INSERT INTO agent_chat_tasks(agent_id,chat_id,user_id,messages,is_first_chat,amount_usdc,status)
          VALUES($1,$2,$3,$4,$5,0,'pending') RETURNING id`, [input.agentId, chatId, input.userId, JSON.stringify(input.messages), !existingChat])).rows[0].id
        await client.query("UPDATE agent_profiles SET last_message_at=now(),updated_at=now(),online_status=CASE WHEN $2 >= max_concurrent_chats THEN 'busy'::online_status ELSE online_status END WHERE id=$1", [input.agentId, pending + 1])
      }
      const decision = eligibility.eligible ? 'free' : 'paid'
      const remaining = Math.max(0, eligibility.freeMessagesRemaining - (eligibility.eligible ? 1 : 0))
      await client.query(`INSERT INTO chat_free_requests(user_id,idempotency_key,agent_id,requested_chat_id,chat_id,messages_hash,decision,task_id,free_messages_remaining,slot_hint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.userId, input.idempotencyKey, input.agentId, input.requestedChatId ?? null, chatId, acceptanceMessagesHash(input.messages), decision, taskId, remaining, eligibility.slotHint ?? null])
      await client.query('COMMIT')
      return { decision, chatId, taskId, freeMessagesRemaining: remaining, slotHint: eligibility.slotHint ?? null }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }
  async function restoreLegacy(input: FreeChatRequestInput, loadCache: () => Promise<{ status: number; body: string } | null>): Promise<ChatRequestDecision | null> {
    const existing = await get(input)
    if (existing) return existing
    let cached: { status: number; body: string } | null
    try { cached = await loadCache() } catch { return fail('legacy_free_cache_unavailable', 503) }
    if (!cached) return null
    let body: { chat_id?: string; is_free?: boolean }
    try { body = JSON.parse(cached.body) } catch { return fail('legacy_free_request_unverified', 503) }
    if (cached.status !== 202 || body.is_free !== true || !body.chat_id) return fail('legacy_free_request_unverified', 503)
    if (input.requestedChatId && input.requestedChatId !== body.chat_id) return fail('idempotency_conflict', 409)
    const client = await pool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId])
      const raced = await read(client, input)
      if (raced) { await client.query('COMMIT'); return raced }
      const chat = (await client.query<{ user_id: string; agent_id: string }>('SELECT user_id,agent_id FROM chats WHERE id=$1', [body.chat_id])).rows[0]
      if (!chat) return fail('legacy_free_request_unverified', 503)
      if (chat.user_id !== input.userId || chat.agent_id !== input.agentId) return fail('idempotency_conflict', 409)
      const task = (await client.query<{ id: string }>('SELECT id FROM agent_chat_tasks WHERE chat_id=$1 AND user_id=$2 AND agent_id=$3 AND amount_usdc=0 AND messages=$4::jsonb ORDER BY created_at LIMIT 1', [body.chat_id, input.userId, input.agentId, JSON.stringify(input.messages)])).rows[0]
      if (!task) return fail('idempotency_conflict', 409)
      const remaining = (await client.query<{ remaining: number }>('SELECT greatest(0,a.free_messages_per_user-coalesce(u.used_count,0)) AS remaining FROM agent_profiles a LEFT JOIN user_agent_free_used u ON u.agent_id=a.id AND u.user_id=$2 WHERE a.id=$1', [input.agentId, input.userId])).rows[0]?.remaining ?? 0
      await client.query(`INSERT INTO chat_free_requests(user_id,idempotency_key,agent_id,requested_chat_id,chat_id,messages_hash,decision,task_id,free_messages_remaining)
        VALUES($1,$2,$3,$4,$5,$6,'free',$7,$8)`, [input.userId, input.idempotencyKey, input.agentId, input.requestedChatId ?? null, body.chat_id, acceptanceMessagesHash(input.messages), task.id, remaining])
      await client.query('COMMIT')
      return { decision: 'free', chatId: body.chat_id, taskId: task.id, freeMessagesRemaining: remaining, slotHint: null }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }
  return { get, consume, restoreLegacy }
}

export function freeChatResponse(result: ChatRequestDecision): Response {
  return Response.json({ chat_id: result.chatId, task_id: result.taskId, status: 'pending', is_free: true,
    free_messages_remaining: result.freeMessagesRemaining, ...(result.slotHint ? { slot_hint: result.slotHint } : {}) },
  { status: 202, headers: { 'X-Chat-Id': result.chatId } })
}
