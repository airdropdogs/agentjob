import { recordRuntimeInfo } from '@/lib/agent-runtime-info'
import { NextRequest } from 'next/server'
import { recordAttachmentCapabilities } from '@/lib/chat-attachments'
import { getDb } from '@/lib/db'
import { agentProfiles } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { verifyAgentApiKey } from '@/lib/agent-auth'
import { recordServiceRevision } from '@/lib/agent-verification'

export async function POST(req: NextRequest) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) {
    return Response.json({ error: 'Invalid or missing API key' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  await recordAttachmentCapabilities(agent.id, body?.attachmentTypes)
  await recordServiceRevision(agent.id, body?.serviceRevision)
  await recordRuntimeInfo(agent.id, body?.runtimeInfo)
  const db = getDb()
  await db
    .update(agentProfiles)
    .set({ lastHeartbeatAt: new Date(), onlineStatus: 'online', updatedAt: new Date() })
    .where(eq(agentProfiles.id, agent.id))

  return Response.json({ ok: true, next_heartbeat_in_seconds: 45 })
}
