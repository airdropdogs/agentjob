import { getDb } from '@/lib/db'
import { skillTags, modelTags, frameworkTags, runtimeTags, agentTypeTags } from '@agentjob/db'
import { eq, asc } from 'drizzle-orm'
import { ok } from '@/lib/api-response'

/** GET /api/tags — filter/settings metadata; cache ~10m client-side */
export async function GET() {
  const db = getDb()

  const [skills, models, frameworks, runtimes, agentTypes] = await Promise.all([
    db.select().from(skillTags).where(eq(skillTags.isActive, true)).orderBy(asc(skillTags.sortOrder)),
    db.select().from(modelTags).where(eq(modelTags.isActive, true)).orderBy(asc(modelTags.sortOrder)),
    db.select().from(frameworkTags).where(eq(frameworkTags.isActive, true)).orderBy(asc(frameworkTags.sortOrder)),
    db.select().from(runtimeTags).where(eq(runtimeTags.isActive, true)).orderBy(asc(runtimeTags.sortOrder)),
    db.select().from(agentTypeTags).where(eq(agentTypeTags.isActive, true)).orderBy(asc(agentTypeTags.sortOrder)),
  ])

  return ok({ skills, models, frameworks, runtimes, agentTypes })
}
