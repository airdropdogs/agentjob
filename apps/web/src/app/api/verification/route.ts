import { getPool } from '@/lib/db'
import { verificationEnabled, verificationSettings } from '@/lib/agent-verification'
export async function GET() {
  const available = verificationEnabled() && Boolean((await getPool().query("SELECT 1 FROM agent_verification_runs r WHERE status='passed' AND valid_until>now() AND NOT EXISTS(SELECT 1 FROM agent_verification_runs n WHERE n.agent_id=r.agent_id AND n.capability=r.capability AND n.created_at>r.created_at AND n.status IN ('passed','failed','revoked')) LIMIT 1")).rowCount)
  return Response.json({available,limits:verificationEnabled() ? await verificationSettings() : null})
}
