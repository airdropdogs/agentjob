import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { users } from '@agentjob/db'
import { eq } from 'drizzle-orm'
import { onrampNetworkReport } from '@/lib/onramp-client-ip'

export async function GET(request: Request) {
  const headers={'Cache-Control':'no-store'}
  const session=await getSession()
  if(!session.userId)return Response.json({error:'Please sign in first.'},{status:401,headers})
  const user=await getDb().query.users.findFirst({where:eq(users.id,session.userId),columns:{bannedAt:true}})
  if(!user||user.bannedAt)return Response.json({error:'Account unavailable.'},{status:403,headers})
  return Response.json({network:onrampNetworkReport(request.headers),note:'Current AgentJob request only. No Coinbase session or payment was created. This does not measure the browser connection to Coinbase or its account-region checks.'},{headers})
}
