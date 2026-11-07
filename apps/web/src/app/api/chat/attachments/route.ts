import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getPool } from '@/lib/db'
import { attachmentCapabilities, attachmentLimits } from '@/lib/chat-attachments'
import { fileContentType } from '@/lib/attachment-policy'
import { attachmentsConfigured, uploadUrl, finalizeObject, downloadUrl } from '@/lib/chat-attachment-storage'

const requestSchema = z.object({ chatId: z.string().uuid(), agentWallet: z.string().regex(/^0x[0-9a-f]{40}$/i),
  name: z.string().min(1).max(180).regex(/^[^\x00-\x1f/\\]+$/), size: z.number().int().positive(),
})
const fail = (message: string, status = 400) => Response.json({ error: message }, { status })
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return fail('Please sign in.', 401)
  if (!attachmentsConfigured()) return Response.json({ enabled: false, acceptedTypes: [] })
  if (req.nextUrl.searchParams.has('id')) {
    const id = z.string().uuid().safeParse(req.nextUrl.searchParams.get('id'))
    if (!id.success) return fail('Invalid attachment.')
    const { rows } = await getPool().query("SELECT * FROM chat_attachments WHERE id=$1 AND user_id=$2 AND state='ready' AND expires_at>now()", [id.data, session.userId])
    if (!rows[0]) return fail('Attachment unavailable or expired.', 404)
    const a = rows[0]
    return new Response(null, { status: 307, headers: { Location: await downloadUrl(a.id, a.name, a.content_type, req.nextUrl.searchParams.get('preview') === '1'), 'Cache-Control': 'private, no-store' } })
  }
  const { rows } = await getPool().query('SELECT a.id FROM agent_profiles a JOIN users u ON u.id=a.user_id WHERE lower(u.wallet)=lower($1) AND a.is_active=true', [req.nextUrl.searchParams.get('agentWallet') ?? ''])
  const acceptedTypes = rows[0] ? await attachmentCapabilities(rows[0].id) : []
  return Response.json({ enabled: acceptedTypes.length > 0, acceptedTypes, limits: await attachmentLimits() }, { headers: { 'Cache-Control': 'no-store' } })
}
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return fail('Please sign in.', 401)
  if (!attachmentsConfigured()) return fail('File uploads are not enabled yet.', 503)
  const parsed = requestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return fail('Invalid file details.')
  const { name, size, chatId, agentWallet } = parsed.data
  const type = fileContentType(name)
  const limits = await attachmentLimits()
  if (!type || size > limits.attachment_max_mb * 1048576) return fail('Unsupported file type or file too large.')
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`attachments:${session.userId}`])
    const { rows } = await client.query('SELECT a.id FROM agent_profiles a JOIN users u ON u.id=a.user_id WHERE lower(u.wallet)=lower($1) AND a.is_active=true', [agentWallet])
    const agent = rows[0]
    if (!agent || !(await attachmentCapabilities(agent.id)).includes(type)) return fail('This Agent does not support this file type.')
    const owner = (await client.query('SELECT user_id,agent_id FROM chats WHERE id=$1', [chatId])).rows[0]
    if (owner && (owner.user_id !== session.userId || owner.agent_id !== agent.id)) return fail('Chat not found.', 404)
    const banned = (await client.query('SELECT banned_at FROM users WHERE id=$1', [session.userId])).rows[0]
    if (!banned || banned.banned_at) return fail('Account unavailable.', 403)
    const usage = (await client.query("SELECT coalesce(sum(size),0)::bigint AS bytes,count(*)::int AS count FROM chat_attachments WHERE user_id=$1 AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [session.userId])).rows[0]
    if (Number(usage.bytes) + size > limits.attachment_daily_mb * 1048576 || usage.count >= 100) return fail('Daily upload limit reached.', 429)
    const id = crypto.randomUUID()
    await client.query("INSERT INTO chat_attachments(id,user_id,agent_id,chat_id,name,content_type,size,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day')", [id, session.userId, agent.id, chatId, name, type, size, limits.attachment_retention_days])
    const url = await uploadUrl(id, type, size)
    await client.query('COMMIT')
    return Response.json({ attachment: { id, name, size, contentType: type }, uploadUrl: url }, { headers: { 'Cache-Control': 'no-store' } })
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}
export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return fail('Please sign in.', 401)
  if (!attachmentsConfigured()) return fail('File uploads are not enabled yet.', 503)
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return fail('Invalid attachment.')
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const a = (await client.query('SELECT * FROM chat_attachments WHERE id=$1 AND user_id=$2 AND task_id IS NULL AND expires_at>now() FOR UPDATE', [parsed.data.id, session.userId])).rows[0]
    if (!a || a.state === 'deleted') return fail('Attachment not found.', 404)
    if (a.state === 'pending') {
      await finalizeObject(a.id, a.content_type, a.size)
      await client.query("UPDATE chat_attachments SET state='ready' WHERE id=$1", [a.id])
    }
    await client.query('COMMIT')
    return Response.json({ ok: true })
  } catch { return fail('Upload could not be verified. Remove the file and try again.', 409) }
  finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}
