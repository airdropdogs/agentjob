import { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users, chats } from '@agentjob/db'
import { eq, like, desc } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'
import { writeAuditLog, getClientIp } from '@/lib/audit'

/** GET /api/admin/accounts?q=search */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')

  const db = getDb()
  const list = await db.query.users.findMany({
    where: q ? like(users.email, `%${q}%`) : undefined,
    orderBy: [desc(users.createdAt)],
    limit: 50,
  })

  return ok(list)
}

const banSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['ban', 'unban']),
  reason: z.string().optional(),
})

/** PATCH /api/admin/accounts — ban or unban user */
export async function PATCH(req: NextRequest) {
  let adminSession
  try {
    adminSession = await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const body = await req.json().catch(() => null)
  const parsed = banSchema.safeParse(body)
  if (!parsed.success) return err('Invalid request', 400)

  const { userId, action, reason } = parsed.data
  const db = getDb()

  if (action === 'ban') {
    await db
      .update(users)
      .set({
        bannedAt: new Date(),
        bannedReason: reason ?? null,
        bannedBy: adminSession.userId,
      })
      .where(eq(users.id, userId))

    // Cancel in-progress chats for banned user
    await db
      .update(chats)
      .set({ status: 'cancelled' })
      .where(eq(chats.userId, userId))
  } else {
    await db
      .update(users)
      .set({ bannedAt: null, bannedReason: null, bannedBy: null })
      .where(eq(users.id, userId))
  }

  writeAuditLog({
    userId: adminSession.userId,
    action: action === 'ban' ? 'ban' : 'unban',
    targetType: 'user',
    targetId: userId,
    metadata: { reason: reason ?? null },
    ipAddress: getClientIp(req),
  })

  return ok({
    message: action === 'ban' ? 'Account banned successfully' : 'Account unbanned successfully',
  })
}
