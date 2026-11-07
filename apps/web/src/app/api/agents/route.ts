import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getDb, getPool } from '@/lib/db'
import {
  agentProfiles,
  agentSkillTags,
  agentFrameworkTags,
  agentRuntimeTags,
  skillTags,
  modelTags,
  frameworkTags,
  runtimeTags,
  agentTypeTags,
  users,
  type AgentProfile,
} from '@agentjob/db'
import { eq, and, desc, asc, inArray, gte, lt, exists, sql, getTableColumns } from 'drizzle-orm'
import { generateApiKey, hashApiKey } from '@/lib/utils'
import { HEARTBEAT_WINDOW_MS, isAgentOnlineByHeartbeat } from '@/lib/agent-auth'
import { getPlatformConfig } from '@/lib/platform-config'
import { ok, err, unauthorized } from '@/lib/api-response'
import { parseCapabilities } from '@/lib/verification-policy'
import { verificationEnabled } from '@/lib/agent-verification'

// price_subsequent buckets
const PRICE_RANGES: Record<string, [number, number | null]> = {
  '0-0.1': [0, 0.1],
  '0.1-0.5': [0.1, 0.5],
  '0.5-1': [0.5, 1],
  '1+': [1, null],
}

const VALID_SORTS = ['online_chats', 'recommended', 'hired_desc', 'chats_desc', 'success_desc', 'bounty_desc', 'newest', 'price_asc', 'price_desc'] as const

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  bio: z.string().max(70).optional(),
  /** @deprecated First message is now free; this field is no longer used */
  priceFirstMsg: z.number().positive().optional(),
  priceSubsequent: z.number().positive(),
  /** Daily free slots (0–100, 0 = disable free feature) */
  freeDailyMax: z.number().int().min(0).max(100).optional(),
  freeMessagesPerUser: z.number().int().min(1).max(100).optional(),
  /** Daily reply cap (0–10000, 0 = unlimited) */
  dailyReplyLimit: z.number().int().min(0).max(10000).optional(),
  modelTagId: z.string().uuid().optional(),
  agentTypeTagId: z.string().uuid().optional(),
  skillTagIds: z.array(z.string().uuid()).max(5).optional(),
  frameworkTagIds: z.array(z.string().uuid()).max(2).optional(),
  runtimeTagIds: z.array(z.string().uuid()).max(2).optional(),
  maxConcurrentChats: z.number().int().min(1).max(5).optional(),
  resetKey: z.boolean().optional(),
})

/**
 * GET /api/agents — filter, sort, paginate
 * capabilities (AND), runtime (OR), agentType, priceRange, status, nft, xVerified, sort, page, pageSize
 */
export async function GET(req: NextRequest) {
  const db = getDb()
  const { searchParams } = new URL(req.url)

  // Query params
  const runtimeIds = searchParams.get('runtime')?.split(',').filter(Boolean) ?? []
  const agentTypeId = searchParams.get('agentType') ?? null
  const priceRange = searchParams.get('priceRange') ?? null
  const statusFilter = searchParams.get('status')?.split(',').filter(Boolean) ?? []
  const nftOnly = searchParams.get('nft') === 'true'
  const xVerifiedOnly = searchParams.get('xVerified') === 'true'
  const sortParam = searchParams.get('sort') ?? 'online_chats'
  const sort = VALID_SORTS.includes(sortParam as typeof VALID_SORTS[number])
    ? (sortParam as typeof VALID_SORTS[number])
    : 'online_chats'
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const pageSize = Math.min(48, Math.max(1, parseInt(searchParams.get('pageSize') ?? '24', 10)))

  // WHERE
  const conditions = [eq(agentProfiles.isActive, true)]
  for (const capability of parseCapabilities(searchParams.get('capabilities'))) {
    conditions.push(verificationEnabled() ? sql`EXISTS (SELECT 1 FROM agent_verification_runs v WHERE v.agent_id=${agentProfiles.id} AND v.capability=${capability} AND v.status='passed' AND v.valid_until>now() AND NOT EXISTS(SELECT 1 FROM agent_verification_runs n WHERE n.agent_id=v.agent_id AND n.capability=v.capability AND n.created_at>v.created_at AND n.status IN ('passed','failed','revoked')))` : sql`false`)
  }

  if (nftOnly) conditions.push(eq(agentProfiles.hasReputationNft, true))
  if (xVerifiedOnly) conditions.push(eq(agentProfiles.xVerified, true))

  // Only Admin-published declarations participate; unreviewed Unknown is not a published Unknown.
  for (const field of ['framework','model'] as const) {
    const values=searchParams.getAll(field).filter(v=>v.length>0&&v.length<=200).slice(0,30)
    if(values.length)conditions.push(sql`EXISTS (SELECT 1 FROM agent_runtime_info ri WHERE ri.agent_id=${agentProfiles.id} AND ri.approved->>${field} IN (${sql.join(values.map(v=>sql`${v}`),sql`,`)}))`)
  }

  // Agent type
  if (agentTypeId) {
    conditions.push(eq(agentProfiles.agentTypeTagId, agentTypeId))
  }

  // Filter the same heartbeat-derived status displayed on cards, before pagination.
  // An explicitly empty status means all; an omitted status defaults to online.
  const effectiveStatuses = searchParams.has('status')
    ? statusFilter.filter(s => ['online', 'busy', 'offline'].includes(s))
    : ['online']
  if (effectiveStatuses.length > 0) {
    const cutoff = new Date(Date.now() - HEARTBEAT_WINDOW_MS).toISOString()
    const liveStatus = sql<string>`CASE WHEN ${agentProfiles.lastHeartbeatAt} > ${cutoff}::timestamptz
      THEN CASE WHEN ${agentProfiles.onlineStatus} = 'busy' THEN 'busy' ELSE 'online' END
      ELSE 'offline' END`
    conditions.push(inArray(liveStatus, effectiveStatuses))
  }

  // Price range on priceSubsequent
  if (priceRange && PRICE_RANGES[priceRange]) {
    const [min, max] = PRICE_RANGES[priceRange]
    conditions.push(gte(agentProfiles.priceSubsequent, String(min)))
    if (max !== null) {
      conditions.push(lt(agentProfiles.priceSubsequent, String(max)))
    }
  }

  // Runtime EXISTS OR
  if (runtimeIds.length > 0) {
    conditions.push(
      exists(
        db.select({ one: sql`1` })
          .from(agentRuntimeTags)
          .where(
            and(
              eq(agentRuntimeTags.agentProfileId, agentProfiles.id),
              inArray(agentRuntimeTags.runtimeTagId, runtimeIds)
            )
          )
      )
    )
  }

  // Order by
  const responseRank = sql<number>`(SELECT CASE
    WHEN count(*) FILTER (WHERE recent.status='failed') >= 2
      AND (array_agg(recent.status ORDER BY recent.created_at DESC))[1]='failed' THEN 2
    WHEN count(*) FILTER (WHERE recent.status='completed') > 0 THEN 0
    ELSE 1 END
    FROM (SELECT status,created_at FROM agent_chat_tasks
      WHERE agent_id="agent_profiles"."id" AND created_at > now()-interval '24 hours' AND verification_run_id IS NULL
        AND status IN ('completed','failed')
      ORDER BY created_at DESC LIMIT 5) recent)`
  const orderBy = {
    online_chats: asc(sql`CASE WHEN ${agentProfiles.lastHeartbeatAt} > ${new Date(Date.now() - HEARTBEAT_WINDOW_MS).toISOString()}::timestamptz THEN CASE WHEN ${agentProfiles.onlineStatus} = 'busy' THEN 1 ELSE 0 END ELSE 2 END`),
    recommended: asc(responseRank),
    hired_desc: desc(agentProfiles.totalHired),
    chats_desc: desc(agentProfiles.totalChats),
    success_desc: desc(agentProfiles.successRate),
    bounty_desc: desc(agentProfiles.totalRevenue),
    newest: desc(agentProfiles.createdAt),
    price_asc: asc(agentProfiles.priceSubsequent),
    price_desc: desc(agentProfiles.priceSubsequent),
  }[sort]

  const agents = await db
    .select({ ...getTableColumns(agentProfiles), responseRank })
    .from(agentProfiles)
    .where(and(...conditions))
    .orderBy(orderBy, desc(agentProfiles.totalChats), desc(agentProfiles.totalHired), asc(agentProfiles.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  // Homepage count is independent of pagination and online/list filters.
  const [{ listedCount }] = await db.select({ listedCount: sql<number>`count(*)::int` })
    .from(agentProfiles).where(eq(agentProfiles.isActive, true))
  if (agents.length === 0) return ok({ agents: [], page, pageSize, listedCount })

  // Batch joins
  const agentIds = agents.map((a: AgentProfile) => a.id)
  const verifiedRows = verificationEnabled() ? (await getPool().query(`SELECT v.agent_id,v.capability FROM agent_verification_runs v WHERE v.agent_id=ANY($1::uuid[]) AND v.status='passed' AND v.valid_until>now() AND NOT EXISTS(SELECT 1 FROM agent_verification_runs n WHERE n.agent_id=v.agent_id AND n.capability=v.capability AND n.created_at>v.created_at AND n.status IN ('passed','failed','revoked'))`,[agentIds])).rows : []
  const approvedRuntimeRows = (await getPool().query('SELECT agent_id,approved FROM agent_runtime_info WHERE agent_id=ANY($1::uuid[]) AND approved IS NOT NULL',[agentIds])).rows
  const userIds = [...new Set(agents.map((a: AgentProfile) => a.userId))]
  const modelTagIds = [...new Set(agents.map((a: AgentProfile) => a.modelTagId).filter(Boolean))] as string[]
  const agentTypeTagIds = [...new Set(agents.map((a: AgentProfile) => a.agentTypeTagId).filter(Boolean))] as string[]

  const [ownerUsers, skillRows, frameworkRows, runtimeRows, modelRows, agentTypeRows] = await Promise.all([
    db.select({ id: users.id, wallet: users.wallet })
      .from(users)
      .where(inArray(users.id, userIds)),

    db.select({ agentProfileId: agentSkillTags.agentProfileId, id: skillTags.id, name: skillTags.name })
      .from(agentSkillTags)
      .innerJoin(skillTags, eq(agentSkillTags.skillTagId, skillTags.id))
      .where(inArray(agentSkillTags.agentProfileId, agentIds)),

    db.select({ agentProfileId: agentFrameworkTags.agentProfileId, id: frameworkTags.id, name: frameworkTags.name })
      .from(agentFrameworkTags)
      .innerJoin(frameworkTags, eq(agentFrameworkTags.frameworkTagId, frameworkTags.id))
      .where(inArray(agentFrameworkTags.agentProfileId, agentIds)),

    db.select({ agentProfileId: agentRuntimeTags.agentProfileId, id: runtimeTags.id, name: runtimeTags.name })
      .from(agentRuntimeTags)
      .innerJoin(runtimeTags, eq(agentRuntimeTags.runtimeTagId, runtimeTags.id))
      .where(inArray(agentRuntimeTags.agentProfileId, agentIds)),

    modelTagIds.length > 0
      ? db.select({ id: modelTags.id, name: modelTags.name, provider: modelTags.provider })
          .from(modelTags)
          .where(inArray(modelTags.id, modelTagIds))
      : Promise.resolve([]),

    agentTypeTagIds.length > 0
      ? db.select({ id: agentTypeTags.id, name: agentTypeTags.name })
          .from(agentTypeTags)
          .where(inArray(agentTypeTags.id, agentTypeTagIds))
      : Promise.resolve([]),
  ])

  // Lookup maps
  const walletByUserId = Object.fromEntries(ownerUsers.map(u => [u.id, u.wallet]))
  const modelById = Object.fromEntries(modelRows.map(m => [m.id, m]))
  const agentTypeById = Object.fromEntries(agentTypeRows.map(t => [t.id, t]))

  const skillsByAgentId = skillRows.reduce<Record<string, { id: string; name: string }[]>>((acc, row) => {
    if (!acc[row.agentProfileId]) acc[row.agentProfileId] = []
    acc[row.agentProfileId].push({ id: row.id, name: row.name })
    return acc
  }, {})

  const frameworksByAgentId = frameworkRows.reduce<Record<string, { id: string; name: string }[]>>((acc, row) => {
    if (!acc[row.agentProfileId]) acc[row.agentProfileId] = []
    acc[row.agentProfileId].push({ id: row.id, name: row.name })
    return acc
  }, {})

  const runtimesByAgentId = runtimeRows.reduce<Record<string, { id: string; name: string }[]>>((acc, row) => {
    if (!acc[row.agentProfileId]) acc[row.agentProfileId] = []
    acc[row.agentProfileId].push({ id: row.id, name: row.name })
    return acc
  }, {})

  const result = agents.map((agent: AgentProfile) => {
    const heartbeatOnline = isAgentOnlineByHeartbeat(agent.lastHeartbeatAt)
    const onlineStatus = heartbeatOnline
      ? (agent.onlineStatus === 'offline' ? 'online' : agent.onlineStatus)
      : 'offline'

    return {
      ...agent,
      approvedRuntime: approvedRuntimeRows.find(r=>r.agent_id===agent.id)?.approved ?? null,
      verifiedCapabilities: verifiedRows.filter(r=>r.agent_id===agent.id).map(r=>r.capability),
      apiKeyHash: undefined,
      walletAddress: walletByUserId[agent.userId] ?? null,
      onlineStatus,
      online: onlineStatus === 'online' || onlineStatus === 'busy',
      skillTags: skillsByAgentId[agent.id] ?? [],
      frameworkTags: frameworksByAgentId[agent.id] ?? [],
      runtimeTags: runtimesByAgentId[agent.id] ?? [],
      modelTag: agent.modelTagId ? (modelById[agent.modelTagId] ?? null) : null,
      agentType: agent.agentTypeTagId ? (agentTypeById[agent.agentTypeTagId] ?? null) : null,
    }
  })

  return ok({ agents: result, page, pageSize, listedCount })
}

/** POST /api/agents — upsert profile; api_key on create or resetKey */
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return unauthorized()

  const body = await req.json().catch(() => null)
  const parsed = registerSchema.safeParse(body)
  if (!parsed.success) {
    return err(parsed.error.issues[0]?.message ?? 'Invalid request', 400)
  }

  const config = await getPlatformConfig()
  if (parsed.data.freeDailyMax !== undefined && parsed.data.freeDailyMax > config.agentFreeMessagesPerUserMax) {
    return err(`Daily free slots cannot exceed the platform maximum of ${config.agentFreeMessagesPerUserMax}`, 400)
  }
  if (parsed.data.freeMessagesPerUser !== undefined && parsed.data.freeMessagesPerUser > config.agentFreeMessagesPerUserMax) {
    return err(`Free messages per user cannot exceed the platform maximum of ${config.agentFreeMessagesPerUserMax}`, 400)
  }
  const { priceSubsequent } = parsed.data

  if (priceSubsequent > config.maxPriceUsdc || priceSubsequent < config.minPriceUsdc) {
    return err(`Subsequent message price must be between ${config.minPriceUsdc} and ${config.maxPriceUsdc} USDC`, 400)
  }

  const db = getDb()
  const existing = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.userId, session.userId),
  })

  let agentId: string
  let returnedApiKey: string | null = null

  const corePayload = {
    name: parsed.data.name,
    description: parsed.data.description,
    bio: parsed.data.bio ?? null,
    priceSubsequent: String(parsed.data.priceSubsequent),
    // priceFirstMsg kept for backward compat, same as priceSubsequent
    priceFirstMsg: String(parsed.data.priceSubsequent),
    ...(parsed.data.freeDailyMax    !== undefined ? { freeDailyMax: parsed.data.freeDailyMax }       : {}),
    ...(parsed.data.freeMessagesPerUser !== undefined ? { freeMessagesPerUser: parsed.data.freeMessagesPerUser } : {}),
    ...(parsed.data.dailyReplyLimit !== undefined ? { dailyReplyLimit: parsed.data.dailyReplyLimit } : {}),
    modelTagId: parsed.data.modelTagId ?? null,
    agentTypeTagId: parsed.data.agentTypeTagId ?? null,
    maxConcurrentChats: parsed.data.maxConcurrentChats ?? (existing?.maxConcurrentChats ?? 2),
    exclusiveMode: (parsed.data.maxConcurrentChats ?? existing?.maxConcurrentChats ?? 2) === 1,
    updatedAt: new Date(),
  }

  if (existing) {
    const shouldResetKey = parsed.data.resetKey === true
    const updatePayload: Record<string, unknown> = { ...corePayload }

    if (shouldResetKey) {
      returnedApiKey = generateApiKey()
      updatePayload.apiKeyHash = hashApiKey(returnedApiKey)
    }

    await db.update(agentProfiles).set(updatePayload).where(eq(agentProfiles.id, existing.id))
    agentId = existing.id
  } else {
    returnedApiKey = generateApiKey()
    const apiKeyHash = hashApiKey(returnedApiKey)

    const [created] = await db
      .insert(agentProfiles)
      .values({
        userId: session.userId,
        ...corePayload,
        apiKeyHash,
        customSkillTags: [],
      })
      .returning({ id: agentProfiles.id })
    agentId = created.id
  }

  // Tag links: delete then insert
  await Promise.all([
    // Skill tags (≤5)
    parsed.data.skillTagIds !== undefined
      ? db.delete(agentSkillTags).where(eq(agentSkillTags.agentProfileId, agentId)).then(async () => {
          if (parsed.data.skillTagIds!.length > 0) {
            await db.insert(agentSkillTags).values(
              parsed.data.skillTagIds!.map(id => ({ agentProfileId: agentId, skillTagId: id }))
            ).onConflictDoNothing()
          }
        })
      : Promise.resolve(),

    // Framework tags (≤2)
    parsed.data.frameworkTagIds !== undefined
      ? db.delete(agentFrameworkTags).where(eq(agentFrameworkTags.agentProfileId, agentId)).then(async () => {
          if (parsed.data.frameworkTagIds!.length > 0) {
            await db.insert(agentFrameworkTags).values(
              parsed.data.frameworkTagIds!.map(id => ({ agentProfileId: agentId, frameworkTagId: id }))
            ).onConflictDoNothing()
          }
        })
      : Promise.resolve(),

    // Runtime tags (≤2)
    parsed.data.runtimeTagIds !== undefined
      ? db.delete(agentRuntimeTags).where(eq(agentRuntimeTags.agentProfileId, agentId)).then(async () => {
          if (parsed.data.runtimeTagIds!.length > 0) {
            await db.insert(agentRuntimeTags).values(
              parsed.data.runtimeTagIds!.map(id => ({ agentProfileId: agentId, runtimeTagId: id }))
            ).onConflictDoNothing()
          }
        })
      : Promise.resolve(),
  ])

  return ok({ agentId, apiKey: returnedApiKey })
}
