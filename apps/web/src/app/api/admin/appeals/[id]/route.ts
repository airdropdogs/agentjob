import { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/session'
import { getDb } from '@/lib/db'
import { appeals } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'
import { writeAuditLog, getClientIp } from '@/lib/audit'

const resolveSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  adminNote: z.string().max(500).optional(),
})

/** PATCH /api/admin/appeals/[id] — resolve appeal (admin) */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session
  try {
    session = await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  const parsed = resolveSchema.safeParse(body)
  if (!parsed.success) return err('Invalid request', 400)

  const { status, adminNote } = parsed.data
  const db = getDb()

  const appeal = await db.query.appeals.findFirst({ where: eq(appeals.id, id) })
  if (!appeal) return err('Appeal not found', 404)
  if (appeal.status !== 'pending') return err('Appeal already resolved', 409)

  const [updated] = await db
    .update(appeals)
    .set({
      status,
      adminNote: adminNote ?? null,
      resolvedBy: session.userId,
      resolvedAt: new Date(),
    })
    .where(eq(appeals.id, id))
    .returning()

  writeAuditLog({
    userId: session.userId,
    action: 'appeal_resolve',
    targetType: 'appeal',
    targetId: id,
    metadata: { status, adminNote: adminNote ?? null },
    ipAddress: getClientIp(req),
  })

  return ok(updated)
}
