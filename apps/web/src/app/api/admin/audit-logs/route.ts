import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getDb } from '@/lib/db'
import { auditLogs, users } from '@agentjob/db'
import { desc, eq } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

/** GET /api/admin/audit-logs?page=1&limit=50 */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'))
  const limit = Math.min(100, parseInt(searchParams.get('limit') ?? '50'))
  const offset = (page - 1) * limit

  const db = getDb()
  const logs = await db.query.auditLogs.findMany({
    orderBy: [desc(auditLogs.createdAt)],
    limit,
    offset,
  })

  // Enrich with operator email
  const enriched = await Promise.all(
    logs.map(async (log) => {
      if (!log.userId) return { ...log, operatorEmail: 'System' }
      const user = await db.query.users.findFirst({
        where: eq(users.id, log.userId),
        columns: { email: true },
      })
      return { ...log, operatorEmail: user?.email ?? 'Unknown' }
    })
  )

  return ok({ logs: enriched, page, limit })
}
