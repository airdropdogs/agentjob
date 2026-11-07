import { NextRequest } from 'next/server'
import { z } from 'zod'
import { verifyAgentApiKey } from '@/lib/agent-auth'
import { getPool } from '@/lib/db'
import { apiKeyRateLimit } from '@/lib/rate-limit'
import { attachmentLimits } from '@/lib/chat-attachments'

export async function GET(req: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { taskId } = await context.params
  if (!z.string().uuid().safeParse(taskId).success) return Response.json({ error: 'Invalid request.' }, { status: 400 })
  if (apiKeyRateLimit && !(await apiKeyRateLimit.limit(agent.id)).success) return Response.json({ error: 'Too many requests.' }, { status: 429 })
  const row = (await getPool().query('SELECT status,cancel_requested_at,progress,timeout_at FROM agent_chat_tasks WHERE id=$1 AND agent_id=$2', [taskId, agent.id])).rows[0]
  if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ status: row.cancel_requested_at ? 'cancelled' : row.status, progress: row.progress, deadline: row.timeout_at, limits: await attachmentLimits() }, { headers: { 'Cache-Control': 'no-store' } })
}
export async function POST(req: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { taskId } = await context.params
  const body = z.object({ seq: z.number().int().min(1).max(1000000000), message: z.string().trim().min(1).max(300), percent: z.number().min(0).max(100).optional() }).safeParse(await req.json().catch(() => null))
  if (!z.string().uuid().safeParse(taskId).success || !body.success) return Response.json({ error: 'Invalid progress.' }, { status: 400 })
  if (apiKeyRateLimit && !(await apiKeyRateLimit.limit(agent.id)).success) return Response.json({ error: 'Too many updates.' }, { status: 429 })
  const result = await getPool().query("UPDATE agent_chat_tasks SET progress=$3 WHERE id=$1 AND agent_id=$2 AND status='claimed' AND cancel_requested_at IS NULL AND timeout_at>now() AND coalesce((progress->>'seq')::int,0)<$4 RETURNING id", [taskId, agent.id, JSON.stringify(body.data), body.data.seq])
  if (result.rowCount) return Response.json({ updated: true })
  const old = (await getPool().query('SELECT status,progress,cancel_requested_at FROM agent_chat_tasks WHERE id=$1 AND agent_id=$2', [taskId, agent.id])).rows[0]
  if (old?.status === 'claimed' && !old.cancel_requested_at && old.progress?.seq >= body.data.seq) return Response.json({ updated: false })
  return Response.json({ error: 'Request is no longer accepting updates.' }, { status: old ? 409 : 404 })
}
