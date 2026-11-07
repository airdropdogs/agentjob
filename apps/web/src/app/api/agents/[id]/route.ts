import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import {
  agentProfiles, agentSkillTags, agentFrameworkTags, agentRuntimeTags,
  skillTags, frameworkTags, runtimeTags, agentTypeTags, modelTags, users,
  agentDailyStats,
} from '@agentjob/db'
import { eq, and } from 'drizzle-orm'
import { isAgentOnlineByHeartbeat } from '@/lib/agent-auth'
import { ok, err } from '@/lib/api-response'
import { FREE_SLOT_WARNING_RATIO } from '@agentjob/shared'
import { getFreeChatPolicy } from '@/lib/free-chat-policy'

function isEthAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

/** GET /api/agents/[id] — UUID or 0x wallet; full profile + tags */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!isEthAddress(id) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return err('Agent not found', 404)
  }
  const db = getDb()

  let agent
  let walletAddress: string | null = null

  if (isEthAddress(id)) {
    const user =
      (await db.query.users.findFirst({ where: eq(users.wallet, id.toLowerCase()) })) ??
      (await db.query.users.findFirst({ where: eq(users.wallet, id) }))
    if (!user) return err('No agent found for this wallet address', 404)
    walletAddress = user.wallet ?? null
    agent = await db.query.agentProfiles.findFirst({ where: eq(agentProfiles.userId, user.id) })
  } else {
    agent = await db.query.agentProfiles.findFirst({ where: eq(agentProfiles.id, id) })
    if (agent) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, agent.userId),
        columns: { wallet: true },
      })
      walletAddress = user?.wallet ?? null
    }
  }

  if (!agent) return err('Agent not found', 404)

  // Load tag relations
  const [skillRows, frameworkRows, runtimeRows, modelRow, agentTypeRow] = await Promise.all([
    db.select({ id: skillTags.id, name: skillTags.name })
      .from(agentSkillTags)
      .innerJoin(skillTags, eq(agentSkillTags.skillTagId, skillTags.id))
      .where(eq(agentSkillTags.agentProfileId, agent.id)),

    db.select({ id: frameworkTags.id, name: frameworkTags.name })
      .from(agentFrameworkTags)
      .innerJoin(frameworkTags, eq(agentFrameworkTags.frameworkTagId, frameworkTags.id))
      .where(eq(agentFrameworkTags.agentProfileId, agent.id)),

    db.select({ id: runtimeTags.id, name: runtimeTags.name })
      .from(agentRuntimeTags)
      .innerJoin(runtimeTags, eq(agentRuntimeTags.runtimeTagId, runtimeTags.id))
      .where(eq(agentRuntimeTags.agentProfileId, agent.id)),

    agent.modelTagId
      ? db.select({ id: modelTags.id, name: modelTags.name, provider: modelTags.provider })
          .from(modelTags)
          .where(eq(modelTags.id, agent.modelTagId))
          .then(r => r[0] ?? null)
      : Promise.resolve(null),

    agent.agentTypeTagId
      ? db.select({ id: agentTypeTags.id, name: agentTypeTags.name })
          .from(agentTypeTags)
          .where(eq(agentTypeTags.id, agent.agentTypeTagId))
          .then(r => r[0] ?? null)
      : Promise.resolve(null),
  ])

  const heartbeatOnline = isAgentOnlineByHeartbeat(agent.lastHeartbeatAt)
  const onlineStatus = heartbeatOnline
    ? (agent.onlineStatus === 'offline' ? 'online' : agent.onlineStatus)
    : 'offline'

  // Compute today's remaining free slots and capacity hint
  const today = new Date().toISOString().slice(0, 10)
  const todayStatRows = await db.select()
    .from(agentDailyStats)
    .where(and(eq(agentDailyStats.agentId, agent.id), eq(agentDailyStats.statDate, today)))
    .limit(1)
  const todayStats = todayStatRows[0]
  const policy = await getFreeChatPolicy()
  const effectiveFreeDailyMax = Math.min(agent.freeDailyMax, policy.agentFreeMessagesPerUserMax)
  const effectiveFreeMessagesPerUser = Math.min(agent.freeMessagesPerUser, policy.agentFreeMessagesPerUserMax)
  const freeUsed      = todayStats?.freeUsersCount ?? 0
  const freeRemaining = Math.max(0, effectiveFreeDailyMax - freeUsed)
  const freeRatio     = effectiveFreeDailyMax > 0 ? freeRemaining / effectiveFreeDailyMax : 1
  const slotHint      = (effectiveFreeDailyMax > 0 && freeRatio <= FREE_SLOT_WARNING_RATIO)
    ? 'Only a few slots left today'
    : undefined

  return ok({
    ...agent,
    apiKeyHash: undefined,
    walletAddress,
    onlineStatus,
    online: onlineStatus === 'online' || onlineStatus === 'busy',
    skillTags: skillRows,
    frameworkTags: frameworkRows,
    runtimeTags: runtimeRows,
    modelTag: modelRow,
    agentType: agentTypeRow,
    effectiveFreeDailyMax,
    effectiveFreeMessagesPerUser,
    freeUserDailyLimit: policy.freeUserDailyLimit,
    freeSlotsRemaining: effectiveFreeDailyMax > 0 ? freeRemaining : 0,
    slotHint,
  })
}
