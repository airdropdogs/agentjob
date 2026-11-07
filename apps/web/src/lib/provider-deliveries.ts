import type { PoolClient } from 'pg'
import { getPool } from './db'
import { attachmentLimits } from './chat-attachments'
import { outputContentType, type ChatAttachment } from './attachment-policy'
import { finalizeObject, uploadUrl } from './chat-attachment-storage'

export class DeliveryError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export async function activeDelivery(client: PoolClient, agentId: string, taskId: string) {
  const task = (await client.query('SELECT * FROM agent_chat_tasks WHERE id=$1 AND agent_id=$2 FOR UPDATE', [taskId, agentId])).rows[0]
  if (!task) throw new DeliveryError('Request not found.', 404)
  if (task.status !== 'claimed' || task.cancel_requested_at || task.timeout_at && new Date(task.timeout_at).getTime() <= Date.now()) throw new DeliveryError('Request is no longer accepting updates.', 409)
  return task
}
export function outputMetadata(row: Record<string, unknown>): ChatAttachment {
  return { id: String(row.id), name: String(row.name), size: Number(row.size), contentType: String(row.content_type),
    ...(row.duration_seconds != null ? { durationSeconds: Number(row.duration_seconds) } : {}) }
}
export async function reserveOutput(agentId: string, taskId: string, input: { id: string; name: string; size: number }) {
  const type = outputContentType(input.name)
  const limits = await attachmentLimits()
  const video = type === 'video/mp4'
  if (!type || input.size > (video ? limits.attachment_video_max_mb : limits.attachment_max_mb) * 1048576) throw new DeliveryError('Unsupported output format or file too large.')
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const task = await activeDelivery(client, agentId, taskId)
    if (task.verification_run_id && (video || input.size > 8 * 1048576)) throw new DeliveryError('This request accepts one image up to 8 MB.')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`output:${agentId}`])
    const old = (await client.query('SELECT * FROM chat_attachments WHERE id=$1', [input.id])).rows[0]
    if (old && (old.task_id !== taskId || old.agent_id !== agentId || old.name !== input.name || old.size !== input.size || old.state === 'deleted' || new Date(old.expires_at).getTime() <= Date.now())) throw new DeliveryError('Upload ID conflict.', 409)
    if (!old) {
      const count = (await client.query("SELECT count(*)::int AS n FROM chat_attachments WHERE task_id=$1 AND (content_type='video/mp4')=$2", [taskId, video])).rows[0].n
      if (count >= (task.verification_run_id ? 1 : video ? limits.attachment_video_max_files : limits.attachment_output_max_files)) throw new DeliveryError('Output count limit reached.', 429)
      const bytes = (await client.query("SELECT coalesce(sum(size),0) AS bytes FROM chat_attachments WHERE agent_id=$1 AND task_id IS NOT NULL AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [agentId])).rows[0].bytes
      if (Number(bytes) + input.size > limits.attachment_output_daily_mb * 1048576) throw new DeliveryError('Daily output upload limit reached.', 429)
      await client.query("INSERT INTO chat_attachments(id,user_id,agent_id,chat_id,task_id,name,content_type,size,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 day')", [input.id, task.user_id, agentId, task.chat_id, taskId, input.name, type, input.size, video ? limits.attachment_video_retention_days : limits.attachment_retention_days])
    }
    const ready = old?.state === 'ready'
    const result = { attachment: old ? outputMetadata(old) : { ...input, contentType: type }, ready, ...(!ready ? { uploadUrl: await uploadUrl(input.id, type, input.size) } : {}) }
    await client.query('COMMIT')
    return result
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}
export async function completeOutput(agentId: string, taskId: string, id: string) {
  const limits = await attachmentLimits()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await activeDelivery(client, agentId, taskId)
    const row = (await client.query("SELECT * FROM chat_attachments WHERE id=$1 AND agent_id=$2 AND task_id=$3 AND state<>'deleted' AND expires_at>now() FOR UPDATE", [id, agentId, taskId])).rows[0]
    if (!row) throw new DeliveryError('Output not found.', 404)
    if (row.state === 'pending') {
      if (row.size > (row.content_type === 'video/mp4' ? limits.attachment_video_max_mb : limits.attachment_max_mb) * 1048576) throw new DeliveryError('File exceeds the current size limit.')
      const duration = await finalizeObject(id, row.content_type, row.size, limits.attachment_video_max_seconds)
      await client.query("UPDATE chat_attachments SET state='ready',duration_seconds=$2 WHERE id=$1", [id, duration ?? null])
      row.duration_seconds = duration
    }
    await client.query('COMMIT')
    return outputMetadata(row)
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}
export async function readyOutputs(agentId: string, taskId: string, ids: string[]) {
  if (!ids.length) return []
  if (new Set(ids).size !== ids.length) throw new DeliveryError('Duplicate output IDs.')
  const rows = (await getPool().query("SELECT * FROM chat_attachments WHERE id=ANY($1::uuid[]) AND agent_id=$2 AND task_id=$3 AND state='ready' AND expires_at>now()", [ids, agentId, taskId])).rows
  if (rows.length !== ids.length) throw new DeliveryError('An output is unavailable or not owned by this request.')
  return ids.map(id => outputMetadata(rows.find(row => row.id === id)!))
}
