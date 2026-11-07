import { NextRequest } from 'next/server'
import { z } from 'zod'
import { verifyAgentApiKey } from '@/lib/agent-auth'
import { attachmentsConfigured } from '@/lib/chat-attachment-storage'
import { reserveOutput, completeOutput, DeliveryError } from '@/lib/provider-deliveries'
import { apiKeyRateLimit } from '@/lib/rate-limit'

const upload = z.object({ id: z.string().uuid(), name: z.string().min(1).max(180).regex(/^[^\x00-\x1f/\\]+$/), size: z.number().int().positive() })
async function handle(req: NextRequest, context: { params: Promise<{ taskId: string }> }, complete: boolean) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!attachmentsConfigured()) return Response.json({ error: 'File delivery is unavailable.' }, { status: 503 })
  if (apiKeyRateLimit && !(await apiKeyRateLimit.limit(agent.id)).success) return Response.json({ error: 'Too many requests.' }, { status: 429 })
  const { taskId } = await context.params
  const input = (complete ? upload.pick({ id: true }) : upload).safeParse(await req.json().catch(() => null))
  if (!z.string().uuid().safeParse(taskId).success || !input.success) return Response.json({ error: 'Invalid upload request.' }, { status: 400 })
  try {
    return Response.json(complete ? { attachment: await completeOutput(agent.id, taskId, input.data.id) } : await reserveOutput(agent.id, taskId, input.data as z.infer<typeof upload>), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof DeliveryError ? error.message : 'File verification failed. Check the format and video duration.' }, { status: error instanceof DeliveryError ? error.status : 422 })
  }
}
export const POST = (req: NextRequest, context: { params: Promise<{ taskId: string }> }) => handle(req, context, false)
export const PATCH = (req: NextRequest, context: { params: Promise<{ taskId: string }> }) => handle(req, context, true)
