import { getDb } from '@/lib/db'
import { agentProfiles } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils'

/** Heartbeat window: online if heartbeat within 2 min */
export const HEARTBEAT_WINDOW_MS = 2 * 60 * 1000

/** True if lastHeartbeatAt is within HEARTBEAT_WINDOW_MS */
export function isAgentOnlineByHeartbeat(lastHeartbeatAt: Date | null | undefined): boolean {
  if (!lastHeartbeatAt) return false
  return Date.now() - new Date(lastHeartbeatAt).getTime() < HEARTBEAT_WINDOW_MS
}

/** Resolve Bearer API key to agent { id, name, lastHeartbeatAt } or null */
export async function verifyAgentApiKey(
  authHeader: string | null
): Promise<{ id: string; name: string; lastHeartbeatAt: Date | null } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null
  const key = authHeader.slice(7).trim()
  if (!key) return null

  const hash = hashApiKey(key)
  const db = getDb()

  const agent = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.apiKeyHash, hash),
    columns: { id: true, name: true, lastHeartbeatAt: true },
  })

  return agent ?? null
}
