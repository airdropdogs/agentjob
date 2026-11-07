import { runtimeInfo, runtimeInfoSchema, approveRuntimeInfo } from '@/lib/agent-runtime-info'
import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getPool } from '@/lib/db'
import { z } from 'zod'
import { capabilitySchema, settingsSchema } from '@/lib/verification-policy'
import { startVerification, startVerificationBatch, cancelVerification, verificationEnabled, evaluatorReady, verificationSettings, VerificationError } from '@/lib/agent-verification'
import { writeAuditLog } from '@/lib/audit'

export async function GET() {
  try { await requireAdmin() } catch { return Response.json({ error:'Forbidden' }, {status:403}) }
  if (!verificationEnabled()) return Response.json({ enabled:false, evaluatorReady:evaluatorReady(), runs:[], agents:[] })
  const db = getPool()
  const [runs, agents, usage] = await Promise.all([
    db.query(`SELECT r.*,a.name FROM agent_verification_runs r JOIN agent_profiles a ON a.id=r.agent_id ORDER BY r.created_at DESC LIMIT 100`),
    db.query(`SELECT a.id,a.name,u.wallet,a.last_heartbeat_at,p.recorded_at AS agreement_at,
      (SELECT count(*)::int FROM agent_verification_runs r WHERE r.agent_id=a.id AND r.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily_used
      FROM agent_profiles a JOIN users u ON u.id=a.user_id LEFT JOIN agent_verification_permissions p ON p.agent_id=a.id WHERE a.is_active=true ORDER BY a.name`),
    db.query("SELECT count(*)::int AS daily_used FROM agent_verification_runs WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"),
  ])
  return Response.json({ enabled:true,evaluatorReady:evaluatorReady(),settings:await verificationSettings(),runs:runs.rows,agents:await Promise.all(agents.rows.map(async a=>({...a,runtime:await runtimeInfo(a.id)}))),dailyUsed:usage.rows[0].daily_used })
}
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action:z.literal('start'), agentId:z.string().uuid(), capability:capabilitySchema, requestKey:z.string().uuid() }),
  z.object({ action:z.literal('start-batch'), agentIds:z.array(z.string().uuid()).min(1).max(20), capabilities:z.array(capabilitySchema).min(1).max(4), requestKey:z.string().uuid() }),
  z.object({ action:z.literal('agreement'), agentId:z.string().uuid() }),
  z.object({ action:z.literal('cancel'), id:z.string().uuid() }),
  z.object({ action:z.literal('review'), id:z.string().uuid(), verdict:z.enum(['passed','failed','revoked']), reason:z.string().min(10).max(1000) }),
  z.object({ action:z.literal('ask-runtime'), agentId:z.string().uuid(), requestKey:z.string().uuid() }),
  z.object({ action:z.literal('runtime-info'), agentId:z.string().uuid(), info:runtimeInfoSchema }),
  z.object({ action:z.literal('settings'), settings:settingsSchema }),
])
export async function POST(req: NextRequest) {
  let admin
  try { admin = await requireAdmin() } catch { return Response.json({ error:'Forbidden' }, {status:403}) }
  if (!verificationEnabled()) return Response.json({error:'Testing is disabled.'},{status:503})
  const input = inputSchema.safeParse(await req.json().catch(()=>null))
  if (!input.success) return Response.json({error:input.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')},{status:400})
  const data = input.data, pool = getPool()
  try {
    let id: string | undefined
    let ids: string[] | undefined
    if (data.action === 'runtime-info' && !await approveRuntimeInfo(data.agentId,data.info,admin.userId)) return Response.json({error:'Agent not found.'},{status:404})
    if (data.action === 'ask-runtime') ids = await startVerificationBatch(admin.userId,[data.agentId],['runtime_info'],data.requestKey)
    if (data.action === 'start') id = await startVerification(admin.userId,data.agentId,data.capability,data.requestKey)
    if (data.action === 'start-batch') ids = await startVerificationBatch(admin.userId,data.agentIds,data.capabilities,data.requestKey)
    if (data.action === 'agreement') await pool.query(`INSERT INTO agent_verification_permissions(agent_id,recorded_by,policy_version) VALUES($1,$2,'1') ON CONFLICT(agent_id) DO UPDATE SET recorded_by=$2,policy_version='1',recorded_at=now()`,[data.agentId,admin.userId])
    if (data.action === 'cancel') await cancelVerification(data.id)
    if (data.action === 'settings') await pool.query(`INSERT INTO platform_config(key,value) VALUES('verification_settings',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,[JSON.stringify(data.settings)])
    if (data.action === 'review') {
      const s = await verificationSettings()
      const changed = await pool.query(`UPDATE agent_verification_runs SET status=$2,result=coalesce(result,'{}'::jsonb)||$3::jsonb,completed_at=now(),revision=revision+1,valid_until=CASE WHEN $2='passed' THEN now()+$4*interval '1 day' ELSE NULL END WHERE id=$1 AND capability<>'runtime_info' AND status IN ('review_required','passed','failed','error') RETURNING id`,[data.id,data.verdict,JSON.stringify({reviewReason:data.reason,reviewedBy:admin.userId}),s.validDays])
      if (!changed.rowCount) return Response.json({error:'This result cannot be reviewed.'},{status:409})
    }
    writeAuditLog({userId:admin.userId,action:'verification',targetType:'agent_verification',metadata:data})
    return Response.json({ok:true,...(id ? {id} : {}),...(ids ? {ids} : {})})
  } catch(e) { return Response.json({error:e instanceof VerificationError ? e.message : 'Verification operation failed.'},{status:e instanceof VerificationError ? e.status : 500}) }
}
