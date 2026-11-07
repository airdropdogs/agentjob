import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  users,
  agentProfiles,
  agentChatTasks,
  agentSkillTags,
  agentFrameworkTags,
  agentRuntimeTags,
  skillTags,
  modelTags,
  frameworkTags,
  runtimeTags,
  agentTypeTags,
  chats,
  payments,
  platformConfig,
  appeals,
  messages,
  auditLogs,
  userWalletSettings,
} from '@agentjob/db'

// Explicit schema map for Drizzle relational queries
const schema = {
  users,
  agentProfiles,
  agentChatTasks,
  agentSkillTags,
  agentFrameworkTags,
  agentRuntimeTags,
  skillTags,
  modelTags,
  frameworkTags,
  runtimeTags,
  agentTypeTags,
  chats,
  payments,
  platformConfig,
  appeals,
  messages,
  auditLogs,
  userWalletSettings,
}

export type AppDb = NodePgDatabase<typeof schema>
let _db: AppDb | null = null

const globalDb = globalThis as typeof globalThis & { agentjobPool?: Pool }
export function getPool(): Pool {
  if (!globalDb.agentjobPool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
    globalDb.agentjobPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, query_timeout: 5000, idleTimeoutMillis: 30000 })
    globalDb.agentjobPool.on('error', () => console.error('[db] Idle PostgreSQL connection failed'))
  }
  return globalDb.agentjobPool
}

export function getDb(): AppDb {
  if (!_db) {
    const sql = getPool()
    _db = drizzle(sql, { schema })
  }
  return _db
}

export { schema }
