import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import { agentChatTasks, chats } from '@agentjob/db'
import { eq, and, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { ok, err, unauthorized } from '@/lib/api-response'

/**
 * GET /api/chat/result/:chatId — poll task status for user's chat.
 * { status: pending|completed|failed, text? }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  try {
    const session = await getSession()
    if (!session.userId) return unauthorized()

    const { chatId } = await params
    const db = getDb()

    // Chat must belong to user
    const chat = await db.query.chats.findFirst({
      where: and(eq(chats.id, chatId), eq(chats.userId, session.userId)),
      columns: { id: true },
    })
    if (!chat) return err('Chat not found or not yours', 404)

    const taskId = req.nextUrl.searchParams.get('taskId')
    if (taskId && !/^[0-9a-f-]{36}$/i.test(taskId)) return err('Invalid request', 400)
    // Latest task for chat
    const task = await db.query.agentChatTasks.findFirst({
      where: and(eq(agentChatTasks.chatId, chatId), taskId ? eq(agentChatTasks.id, taskId) : undefined),
      orderBy: [desc(agentChatTasks.createdAt)],
      columns: { id: true, status: true, responseText: true, responseAttachments: true, progress: true, cancelRequestedAt: true },
    })

    if (!task) {
      return ok({ status: 'pending' })
    }

    if (task.cancelRequestedAt) return ok({ status: 'cancelled' })
    if (task.status === 'completed') {
      return ok({ status: 'completed', text: task.responseText ?? '', attachments: task.responseAttachments })
    }

    if (task.status === 'failed') {
      return ok({ status: 'failed' })
    }

    // pending / claimed
    return ok({ status: 'pending', progress: task.progress })
  } catch (e) {
    console.error('[GET /api/chat/result/:chatId]', e)
    return err(
      e instanceof Error ? e.message : 'Internal server error',
      500
    )
  }
}
