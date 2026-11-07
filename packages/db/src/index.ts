import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

export function createDb(databaseUrl: string) {
  const sql = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000 })
  return drizzle(sql, { schema })
}

export * from './schema'
export { schema }
