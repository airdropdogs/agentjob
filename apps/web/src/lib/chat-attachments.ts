import { getPool } from './db'
import { getRedisOptional } from './rate-limit'
import { ATTACHMENT_LIMITS, FILE_TYPES, type ChatAttachment } from './attachment-policy'
import { attachmentsConfigured, downloadUrl } from './chat-attachment-storage'
type StoredAttachment = { id: string; name: string; content_type: string; size: number; state: string; expires_at: Date; task_id?: string | null }

export async function attachmentLimits() {
  const { rows } = await getPool().query('SELECT key,value FROM platform_config WHERE key LIKE $1', ['attachment_%'])
  const saved = Object.fromEntries(rows.map(r => [r.key, Number(r.value)]))
  return Object.fromEntries(Object.entries(ATTACHMENT_LIMITS).map(([k, v]) => [k,
    Number.isInteger(saved[k]) && saved[k] >= v.min && saved[k] <= v.max ? saved[k] : v.default]))
}
export async function attachmentCapabilities(agentId: string): Promise<string[]> {
  if (!attachmentsConfigured()) return []
  const raw = await getRedisOptional()?.get(`attachments:agent:${agentId}`)
  return raw ? JSON.parse(raw) : []
}
export async function recordAttachmentCapabilities(agentId: string, input: unknown) {
  const allowed = Array.isArray(input) ? [...new Set(input.filter((v): v is string => typeof v === 'string' && Object.values(FILE_TYPES).includes(v)))].slice(0, 10) : []
  await getRedisOptional()?.set(`attachments:agent:${agentId}`, JSON.stringify(allowed), { ex: 120 })
}
export async function validateChatAttachments(messages: Array<{ role: string; attachments?: ChatAttachment[] }>, userId: string, agentId: string, chatId: string) {
  const stored = new Map<string, StoredAttachment>()
  if (messages.some(m => m.attachments != null && !Array.isArray(m.attachments))) throw new Error('Invalid attachments.')
  if (!messages.some(m => m.attachments?.length)) return stored
  const limits = await attachmentLimits()
  if (messages.some(m => m.attachments && (!Array.isArray(m.attachments) || m.attachments.length > 15 || !['user', 'assistant'].includes(m.role))) || (messages.at(-1)?.attachments?.length ?? 0) > limits.attachment_max_files) throw new Error('Invalid attachments.')
  const files = messages.flatMap(m => m.attachments ?? [])
  if (files.some(file => !file || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(file.id))) throw new Error('Invalid attachment.')
  const { rows } = await getPool().query<StoredAttachment>('SELECT * FROM chat_attachments WHERE id=ANY($1::uuid[]) AND user_id=$2 AND agent_id=$3 AND chat_id=$4', [[...new Set(files.map(a => a.id))], userId, agentId, chatId])
  for (const row of rows) stored.set(row.id, row)
  for (const message of messages) for (const file of message.attachments ?? []) {
    if (Boolean(stored.get(file.id)?.task_id) !== (message.role === 'assistant')) throw new Error('Attachment role mismatch.')
  }
  const supported = await attachmentCapabilities(agentId)
  const current = new Set((messages.at(-1)?.attachments ?? []).map(a => a.id))
  for (const file of files) {
    const row = stored.get(file.id)
    if (!row || row.name !== file.name || row.content_type !== file.contentType || row.size !== file.size) throw new Error('Attachment unavailable or expired. Remove it and upload again.')
    if (current.has(file.id) && (row.state !== 'ready' || new Date(row.expires_at).getTime() <= Date.now())) throw new Error('Attachment expired. Upload it again before sending.')
    if (current.has(file.id) && !supported.includes(row.content_type)) throw new Error('This Agent does not currently support this file type. No new payment has been requested.')
  }
  return stored
}
export async function providerAttachments(messages: Array<{role: string; content: string; attachments?: ChatAttachment[]}>, userId: string, agentId: string, chatId: string, callerTypes?: string[]) {
  const stored = await validateChatAttachments(messages, userId, agentId, chatId)
  const supported = (await attachmentCapabilities(agentId)).filter(t => !callerTypes || callerTypes.includes(t))
  return Promise.all(messages.map(async message => {
    const attachments = []
    let content = message.content
    for (const a of message.attachments ?? []) {
      const row = stored.get(a.id)
      if (row?.state === 'ready' && new Date(row.expires_at).getTime() > Date.now() && supported.includes(a.contentType)) attachments.push({ id: a.id, name: a.name, size: a.size, contentType: a.contentType, url: await downloadUrl(a.id, a.name, a.contentType) })
      else content += `\n[Earlier attachment no longer available: ${a.name}]`
    }
    return { role: message.role, content, ...(attachments.length ? { attachments } : {}) }
  }))
}
