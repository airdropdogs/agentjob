import { requireAdmin } from '@/lib/session'
import { getPool } from '@/lib/db'
import { downloadUrl } from '@/lib/chat-attachment-storage'
import { z } from 'zod'
export async function GET(_req: Request,{params}:{params:Promise<{id:string}>}) {
  try{await requireAdmin()}catch{return Response.json({error:'Forbidden'},{status:403})}
  const {id}=await params
  if(!z.string().uuid().safeParse(id).success)return Response.json({error:'Invalid ID'},{status:400})
  const row=(await getPool().query('SELECT r.challenge,t.response_text,t.response_attachments FROM agent_verification_runs r LEFT JOIN agent_chat_tasks t ON t.id=r.task_id WHERE r.id=$1',[id])).rows[0]
  if(!row)return Response.json({error:'Not found'},{status:404})
  const ids=[row.challenge.sourceId,...(row.response_attachments??[]).map((a:any)=>a.id)].filter(Boolean)
  const files=(await getPool().query("SELECT * FROM chat_attachments WHERE id=ANY($1::uuid[]) AND state='ready' AND expires_at>now()",[ids])).rows
  return Response.json({...row,files:await Promise.all(files.map(async f=>({name:f.name,url:await downloadUrl(f.id,f.name,f.content_type)})))},{headers:{'cache-control':'no-store'}})
}
