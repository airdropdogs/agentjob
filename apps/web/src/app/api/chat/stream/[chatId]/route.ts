import { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { chats, agentChatTasks } from '@agentjob/db'
import { eq, and, desc } from 'drizzle-orm'
import { subscribeChat } from '@/lib/stream-bus'
import { z } from 'zod'

export async function GET(req: NextRequest, { params }: { params: Promise<{ chatId: string }> }) {
  const session = await getSession()
  if (!session.userId) return new Response('Unauthorized', { status: 401 })
  const { chatId } = await params
  const taskId = req.nextUrl.searchParams.get('taskId')
  if (!z.string().uuid().safeParse(chatId).success || taskId && !z.string().uuid().safeParse(taskId).success) return new Response('Invalid request', { status: 400 })
  const db = getDb()
  const chat = await db.query.chats.findFirst({ where: and(eq(chats.id, chatId), eq(chats.userId, session.userId)), columns: { id: true } })
  if (!chat) return new Response('Not found', { status: 404 })
  let cleanup = () => {}
  const stream = new ReadableStream({
    start(controller) {
      let closed = false, polling = false, seq = -1
      let unsubscribe = () => {}
      const encoder = new TextEncoder()
      const send = (chunk: object) => { if (!closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n')) }
      const close = () => { if (closed) return; cleanup(); try { controller.close() } catch {} }
      const poll = async () => {
        if (closed || polling) return
        polling = true
        try {
          const task = await db.query.agentChatTasks.findFirst({
            where: and(eq(agentChatTasks.chatId, chatId), taskId ? eq(agentChatTasks.id, taskId) : undefined),
            orderBy: [desc(agentChatTasks.createdAt)],
            columns: { status: true, responseText: true, responseAttachments: true, progress: true, cancelRequestedAt: true },
          })
          if (closed || !task) return
          if (task.cancelRequestedAt) { send({ type: 'cancelled' }); close() }
          else if (task.status === 'completed') { send({ type: 'done', text: task.responseText ?? '', attachments: task.responseAttachments }); close() }
          else if (task.status === 'failed') { send({ type: 'error' }); close() }
          else if (task.progress && task.progress.seq > seq) { seq = task.progress.seq; send({ type: 'progress', progress: task.progress }) }
        } catch { /* Poll again after a transient database error. */ }
        finally { polling = false }
      }
      const timer = setInterval(poll, 3000)
      const ping = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')) }, 15000)
      const timeout = setTimeout(close, 5 * 60 * 1000)
      cleanup = () => { closed = true; clearInterval(timer); clearInterval(ping); clearTimeout(timeout); unsubscribe(); req.signal.removeEventListener('abort', close) }
      // Legacy stream chunks are not request-scoped. Scoped clients use persisted results.
      if (!taskId) unsubscribe = subscribeChat(chatId, chunk => { send(chunk); if (chunk.type === 'done' || chunk.type === 'error') close() })
      req.signal.addEventListener('abort', close, { once: true })
      if (req.signal.aborted) close(); else void poll()
    },
    cancel() { cleanup() },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } })
}
