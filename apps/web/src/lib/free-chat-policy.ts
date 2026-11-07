import type { Pool, PoolClient } from 'pg'
import { getPool } from './db'

export const FREE_CHAT_LIMITS = {
  free_user_daily_limit: { min: 0, max: 10000, fallback: 2 },
  agent_free_messages_per_user_max: { min: 1, max: 100, fallback: 100 },
} as const

export function validFreeChatLimit(key: string, value: string): boolean {
  const limit = FREE_CHAT_LIMITS[key as keyof typeof FREE_CHAT_LIMITS]
  return !limit || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= limit.min && Number(value) <= limit.max)
}

export async function getFreeChatPolicy(client: Pool | PoolClient = getPool()) {
  const { rows } = await client.query<{ key: string; value: string }>('SELECT key,value FROM platform_config WHERE key=ANY($1::text[])', [Object.keys(FREE_CHAT_LIMITS)])
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]))
  const read = (key: keyof typeof FREE_CHAT_LIMITS) => values[key] !== undefined && validFreeChatLimit(key, values[key]) ? Number(values[key]) : FREE_CHAT_LIMITS[key].fallback
  return { freeUserDailyLimit: read('free_user_daily_limit'), agentFreeMessagesPerUserMax: read('agent_free_messages_per_user_max') }
}
