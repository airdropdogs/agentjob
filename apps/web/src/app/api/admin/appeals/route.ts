import { requireAdmin } from '@/lib/session'
import { getDb } from '@/lib/db'
import { appeals, users, agentProfiles } from '@agentjob/db'
import { eq, desc } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

/** GET /api/admin/appeals — list all appeals (admin) */
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const db = getDb()
  const list = await db.query.appeals.findMany({
    orderBy: [desc(appeals.createdAt)],
    limit: 100,
  })

  // Enrich with user and agent display names
  const enriched = await Promise.all(
    list.map(async (a) => {
      const user = await db.query.users.findFirst({
        where: eq(users.id, a.userId),
        columns: { email: true },
      })
      const agent = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.id, a.agentId),
        columns: { name: true },
      })
      return { ...a, userEmail: user?.email ?? 'Unknown', agentName: agent?.name ?? 'Unknown' }
    })
  )

  return ok(enriched)
}
