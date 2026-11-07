import { z } from 'zod'
import { getPool } from './db'

export const runtimeInfoSchema = z.object({
  framework: z.string().trim().max(100).default('Unknown'),
  model: z.string().trim().max(200).default('Unknown'),
})
export function normalizeRuntimeInfo(input: z.infer<typeof runtimeInfoSchema>) {
  const framework = input.framework.replace(/(?:\s+v?\d[\w.-]*|@v?\d[\w.-]*)$/i, '').trim() || 'Unknown'
  const aliases: Record<string,string> = {'openclaw':'OpenClaw','codex':'Codex','claude-code':'Claude Code','claude code':'Claude Code','hermes':'Hermes','hermes agent':'Hermes','custom-http':'Custom','unknown':'Unknown'}
  return {framework:aliases[framework.toLowerCase()] ?? framework,model:input.model.trim() || 'Unknown'}
}
export function parseRuntimeReply(text:string) {
  try {
    const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))
    return normalizeRuntimeInfo(runtimeInfoSchema.parse(value))
  } catch { return {framework:'Unknown',model:'Unknown'} }
}
export async function recordRuntimeInfo(agentId:string, raw:unknown) {
  if (raw == null) return
  const parsed=runtimeInfoSchema.safeParse(raw)
  if (!parsed.success) return
  const info={...normalizeRuntimeInfo(parsed.data),source:'connector'}
  await getPool().query(`INSERT INTO agent_runtime_info(agent_id,reported,reported_at) VALUES($1,$2,now())
    ON CONFLICT(agent_id) DO UPDATE SET reported=$2,reported_at=now() WHERE agent_runtime_info.reported IS DISTINCT FROM $2::jsonb`,[agentId,info])
}
export async function runtimeInfo(agentId:string) {
  const row=(await getPool().query(`SELECT ri.self_report,ri.reported,ri.approved,ri.approved_at,m.name AS model,
    (SELECT string_agg(f.name, ', ' ORDER BY f.name) FROM agent_framework_tags af JOIN framework_tags f ON f.id=af.framework_tag_id WHERE af.agent_profile_id=a.id) AS framework
    FROM agent_profiles a LEFT JOIN model_tags m ON m.id=a.model_tag_id LEFT JOIN agent_runtime_info ri ON ri.agent_id=a.id WHERE a.id=$1`,[agentId])).rows[0]
  if (!row) return null
  const fallback=normalizeRuntimeInfo({framework:row.framework??'Unknown',model:row.model??'Unknown'})
  return {draft:row.self_report??row.reported??{...fallback,source:row.framework||row.model?'provider':'unknown'},approved:row.approved,approvedAt:row.approved_at}
}
export async function approveRuntimeInfo(agentId:string, info:z.infer<typeof runtimeInfoSchema>, adminId:string) {
  const current=await runtimeInfo(agentId)
  if (!current) return false
  const normalized=normalizeRuntimeInfo(info)
  const matches=(v:any)=>v?.framework===normalized.framework && v?.model===normalized.model
  const source=matches(current.draft)?current.draft.source:matches(current.approved)?current.approved.source:'admin'
  await getPool().query(`INSERT INTO agent_runtime_info(agent_id,approved,approved_by,approved_at) VALUES($1,$2,$3,now())
    ON CONFLICT(agent_id) DO UPDATE SET approved=$2,approved_by=$3,approved_at=now()`,[agentId,{...normalized,source},adminId])
  return true
}
