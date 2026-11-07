import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getPool } from '@/lib/db'

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const body = z.object({ taskId: z.string().uuid(), chatId: z.string().uuid() }).safeParse(await req.json().catch(() => null))
  if (!body.success) return Response.json({ error: 'Invalid request.' }, { status: 400 })
  const { taskId, chatId } = body.data
  const result = await getPool().query("UPDATE agent_chat_tasks SET status='failed',cancel_requested_at=now(),completed_at=now() WHERE id=$1 AND chat_id=$2 AND user_id=$3 AND status IN ('pending','claimed') RETURNING id", [taskId, chatId, session.userId])
  if (result.rowCount) return Response.json({ status: 'cancelled' })
  const old = (await getPool().query('SELECT status,cancel_requested_at FROM agent_chat_tasks WHERE id=$1 AND chat_id=$2 AND user_id=$3', [taskId, chatId, session.userId])).rows[0]
  if (!old) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ status: old.cancel_requested_at ? 'cancelled' : old.status })
}
