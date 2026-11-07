import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { getRedisOptional } from '@/lib/redis-limiters'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const redis = getRedisOptional()
    if (!redis) throw new Error('Redis is required')
    await Promise.all([
      getPool().query('SELECT 1'),
      redis.client.ping(),
    ])
    return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
