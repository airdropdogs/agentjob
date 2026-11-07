import { NextRequest } from 'next/server'
import { processVerification } from '@/lib/agent-verification'
export async function POST(req: NextRequest) {
  if (!process.env.INTERNAL_API_SECRET || req.headers.get('x-internal-secret') !== process.env.INTERNAL_API_SECRET) return Response.json({ error:'Forbidden' }, { status:403 })
  return Response.json(await processVerification())
}
