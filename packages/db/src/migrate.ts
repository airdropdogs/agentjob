import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'

/**
 * Loads .env in order (later overrides): root .env, .env.local, apps/web/.env, apps/web/.env.local.
 * Put DATABASE_URL where your runner reads it (web vs CLI).
 */
const root = path.resolve(__dirname, '../../..')
const webDir = path.join(root, 'apps', 'web')
;[path.join(root, '.env'), path.join(root, '.env.local'), path.join(webDir, '.env'), path.join(webDir, '.env.local')].forEach((p) => {
  if (fs.existsSync(p)) dotenv.config({ path: p, override: true })
})

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const sql = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000 })
  const db = drizzle(sql)

  console.log('Running migrations...')
  try {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, '../migrations') })
  } finally {
    await sql.end()
  }
  console.log('Migrations completed!')
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
