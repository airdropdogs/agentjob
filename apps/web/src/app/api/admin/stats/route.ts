import { requireAdmin } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users, agentProfiles, chats, payments, appeals } from '@agentjob/db'
import { eq, count, sum, gte, desc } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

/** GET /api/admin/stats — dashboard stats (admin) */
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return err('Forbidden', 403)
  }

  const db = getDb()

  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const [
    [totalUsersRow],
    [newUsersRow],
    [totalAgentsRow],
    [totalChatsRow],
    [completedChatsRow],
    [activeChatsRow],
    [totalRevenueRow],
    [pendingAppealsRow],
    recentPayments,
  ] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(users).where(gte(users.createdAt, sevenDaysAgo)),
    db.select({ value: count() }).from(agentProfiles).where(eq(agentProfiles.isActive, true)),
    db.select({ value: count() }).from(chats),
    db.select({ value: count() }).from(chats).where(eq(chats.status, 'completed')),
    db.select({ value: count() }).from(chats).where(eq(chats.status, 'active')),
    db.select({ value: sum(payments.amountPlatform) }).from(payments).where(eq(payments.status, 'success')),
    db.select({ value: count() }).from(appeals).where(eq(appeals.status, 'pending')),
    db.query.payments.findMany({
      orderBy: [desc(payments.createdAt)],
      limit: 10,
      columns: {
        id: true,
        amountPlatform: true,
        amountAgent: true,
        status: true,
        createdAt: true,
      },
    }),
  ])

  return ok({
    users: {
      total: Number(totalUsersRow.value),
      newLast7Days: Number(newUsersRow.value),
    },
    agents: {
      active: Number(totalAgentsRow.value),
    },
    chats: {
      total: Number(totalChatsRow.value),
      completed: Number(completedChatsRow.value),
      active: Number(activeChatsRow.value),
    },
    revenue: {
      platformTotal: totalRevenueRow.value ? Number(totalRevenueRow.value).toFixed(4) : '0.0000',
    },
    appeals: {
      pending: Number(pendingAppealsRow.value),
    },
    recentPayments,
  })
}
