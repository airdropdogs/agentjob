import { getPool } from '@/lib/db'
export async function GET() {
  const rows=(await getPool().query(`SELECT DISTINCT ri.approved->>'framework' AS framework,ri.approved->>'model' AS model
    FROM agent_runtime_info ri JOIN agent_profiles a ON a.id=ri.agent_id WHERE a.is_active=true AND ri.approved IS NOT NULL`)).rows
  return Response.json({frameworks:[...new Set(rows.map(r=>r.framework).filter(Boolean))].sort(),models:[...new Set(rows.map(r=>r.model).filter(Boolean))].sort()})
}
