import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/session'
import { getDb } from '@/lib/db'
import { chats, messages, agentProfiles, users, agentChatTasks } from '@agentjob/db'
import { eq, and, desc, asc, sql } from 'drizzle-orm'
import { ok, err, unauthorized } from '@/lib/api-response'

/**
 * GET /api/chat/history
 * ?chatId= — messages for that chat
 * (no param) — up to 50 chat summaries for the user
 */
export async function GET(req: NextRequest) {
  let session
  try {
    session = await requireAuth()
  } catch {
    return unauthorized()
  }

  const { searchParams } = new URL(req.url)
  const chatId = searchParams.get('chatId')
  const agentWallet = searchParams.get('agentWallet')
  const db = getDb()

  if (chatId) {
    // Chat must belong to user
    const chat = await db.query.chats.findFirst({
      where: and(eq(chats.id, chatId), eq(chats.userId, session.userId)),
    })
    if (!chat) return err('Chat not found', 404)

    const msgs = await db.query.messages.findMany({
      where: eq(messages.chatId, chatId),
      orderBy: [asc(messages.createdAt)],
    })

    const latest = await db.query.agentChatTasks.findFirst({ where: eq(agentChatTasks.chatId, chatId), orderBy: [desc(agentChatTasks.createdAt)], columns: { id: true, status: true, progress: true } })
    const activeRequest = latest && ['pending', 'claimed'].includes(latest.status) ? latest : null
    return ok({ chatId, messages: msgs, activeRequest })
  }

  // Summaries: agentName + first user line as title
  let agentId: string | undefined
  if (agentWallet) {
    if (!/^0x[0-9a-f]{40}$/i.test(agentWallet)) return err('Invalid Agent wallet', 400)
    const owner = await db.query.users.findFirst({ where: sql`lower(${users.wallet}) = ${agentWallet.toLowerCase()}`, columns: { id: true } })
    const agent = owner && await db.query.agentProfiles.findFirst({ where: eq(agentProfiles.userId, owner.id), columns: { id: true } })
    if (!agent) return ok([])
    agentId = agent.id
  }
  const userChats = await db.query.chats.findMany({
    where: and(eq(chats.userId, session.userId), agentId ? eq(chats.agentId, agentId) : undefined),
    orderBy: [desc(sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`), desc(chats.createdAt)],
    limit: 50,
  })

  const summaries = await Promise.all(
    userChats.map(async (chat) => {
      const agent = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.id, chat.agentId),
        columns: { name: true, userId: true },
      })
      const agentUser = agent?.userId
        ? await db.query.users.findFirst({
            where: eq(users.id, agent.userId),
            columns: { wallet: true },
          })
        : null

      const firstUserMsg = await db.query.messages.findFirst({
        where: and(eq(messages.chatId, chat.id), eq(messages.role, 'user')),
        orderBy: [asc(messages.createdAt)],
        columns: { content: true },
      })

      return {
        id: chat.id,
        agentId: chat.agentId,
        agentName: agent?.name ?? 'Unknown agent',
        agentWallet: agentUser?.wallet ?? null,
        title: firstUserMsg?.content?.slice(0, 60) ?? 'Chat',
        status: chat.status,
        totalMessages: chat.totalMessages,
        createdAt: chat.createdAt,
        lastMessageAt: chat.lastMessageAt,
      }
    })
  )

  return ok(summaries)
}
