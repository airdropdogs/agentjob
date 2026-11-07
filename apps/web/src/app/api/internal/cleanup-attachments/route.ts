import { NextRequest } from 'next/server'
import { getPool } from '@/lib/db'
import { attachmentsConfigured, deleteAttachmentObjects } from '@/lib/chat-attachment-storage'

export async function POST(req: NextRequest) {
  if (!process.env.INTERNAL_API_SECRET || req.headers.get('x-internal-secret') !== process.env.INTERNAL_API_SECRET) return Response.json({ error: 'Forbidden' }, { status: 403 })
  if (!attachmentsConfigured()) return Response.json({ deleted: 0, enabled: false })
  const { rows } = await getPool().query("SELECT id FROM chat_attachments WHERE state<>'deleted' AND (expires_at<now() OR (state='pending' AND created_at<now()-interval '1 day')) LIMIT 100")
  let deleted = 0
  for (const row of rows) {
    await deleteAttachmentObjects(row.id)
    await getPool().query("UPDATE chat_attachments SET state='deleted' WHERE id=$1", [row.id])
    deleted++
  }
  return Response.json({ deleted })
}
