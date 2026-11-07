import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import {
  agentProfiles, agentSkillTags, agentFrameworkTags, agentRuntimeTags,
  skillTags, frameworkTags, runtimeTags, agentTypeTags, modelTags, users,
} from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { ok, unauthorized } from '@/lib/api-response'
import { isAgentOnlineByHeartbeat, verifyAgentApiKey } from '@/lib/agent-auth'

/** GET /api/agents/me — current user's agent profile + tags */
export async function GET(req: Request) {
  // Provider keys identify an agent, not a browser session or its owner's account.
  if (req.headers.has('authorization')) {
    const agent = await verifyAgentApiKey(req.headers.get('authorization'))
    if (!agent) return unauthorized()
    const [owner] = await getDb().select({ wallet: users.wallet })
      .from(users)
      .innerJoin(agentProfiles, eq(agentProfiles.userId, users.id))
      .where(eq(agentProfiles.id, agent.id))
      .limit(1)
    return ok({
      id: agent.id,
      name: agent.name,
      profileUrl: `https://agent-job.ai/agents/${agent.id}`,
      chatUrl: owner?.wallet ? `https://agent-job.ai/chat/${owner.wallet}` : null,
      online: isAgentOnlineByHeartbeat(agent.lastHeartbeatAt),
    })
  }

  const session = await getSession()
  if (!session.userId) return unauthorized()

  const db = getDb()
  const profile = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.userId, session.userId),
  })

  if (!profile) return ok(null)

  const [skillRows, frameworkRows, runtimeRows, modelRow, agentTypeRow] = await Promise.all([
    db.select({ id: skillTags.id, name: skillTags.name })
      .from(agentSkillTags)
      .innerJoin(skillTags, eq(agentSkillTags.skillTagId, skillTags.id))
      .where(eq(agentSkillTags.agentProfileId, profile.id)),

    db.select({ id: frameworkTags.id, name: frameworkTags.name })
      .from(agentFrameworkTags)
      .innerJoin(frameworkTags, eq(agentFrameworkTags.frameworkTagId, frameworkTags.id))
      .where(eq(agentFrameworkTags.agentProfileId, profile.id)),

    db.select({ id: runtimeTags.id, name: runtimeTags.name })
      .from(agentRuntimeTags)
      .innerJoin(runtimeTags, eq(agentRuntimeTags.runtimeTagId, runtimeTags.id))
      .where(eq(agentRuntimeTags.agentProfileId, profile.id)),

    profile.modelTagId
      ? db.select({ id: modelTags.id, name: modelTags.name })
          .from(modelTags)
          .where(eq(modelTags.id, profile.modelTagId))
          .then(r => r[0] ?? null)
      : Promise.resolve(null),

    profile.agentTypeTagId
      ? db.select({ id: agentTypeTags.id, name: agentTypeTags.name })
          .from(agentTypeTags)
          .where(eq(agentTypeTags.id, profile.agentTypeTagId))
          .then(r => r[0] ?? null)
      : Promise.resolve(null),
  ])

  return ok({
    ...profile,
    skillTags: skillRows,
    frameworkTags: frameworkRows,
    runtimeTags: runtimeRows,
    modelTag: modelRow,
    agentType: agentTypeRow,
  })
}
