import { runtimeInfo } from '@/lib/agent-runtime-info'
import { getPool } from '@/lib/db'
import { publicVerification, verificationEnabled } from '@/lib/agent-verification'
export async function GET(_req: Request, {params}: {params:Promise<{id:string}>}) {
  if (!verificationEnabled()) return Response.json({enabled:false,results:[]})
  const {id: walletAddress} = await params
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) return Response.json({error:'Invalid address'},{status:400})
  const agent = (await getPool().query('SELECT a.id FROM agent_profiles a JOIN users u ON u.id=a.user_id WHERE lower(u.wallet)=lower($1) AND a.is_active=true',[walletAddress])).rows[0]
  return Response.json({enabled:true,runtime:agent ? (await runtimeInfo(agent.id))?.approved ?? null : null,results:agent ? await publicVerification(agent.id) : []})
}

