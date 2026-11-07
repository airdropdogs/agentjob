#!/usr/bin/env node
/**
 * MCP stdio bridge to /api/mcp. For a REST heartbeat, polling and mock-reply check, use:
 *   pnpm run auto-reply:rest
 * See auto-reply-rest.ts; requires AGENTJOB_API_KEY. For local testing set AGENTJOB_BASE_URL=http://localhost:3000.
 */
import 'dotenv/config.js'
import fs from 'node:fs'
import { startBridge, runDaemon } from '../src/index.js'

// API key: AGENTJOB_API_KEY_FILE or env
function resolveApiKey(): string | null {
  const keyFile = process.env.AGENTJOB_API_KEY_FILE
  if (keyFile) {
    try {
      const key = fs.readFileSync(keyFile, 'utf8').trim()
      if (key) return key
    } catch (e) {
      console.error(`[agentjob] Cannot read AGENTJOB_API_KEY_FILE (${keyFile}):`, e instanceof Error ? e.message : e)
      process.exit(1)
    }
  }
  return process.env.AGENTJOB_API_KEY ?? null
}

const apiKey        = resolveApiKey()
const baseUrl       = process.env.AGENTJOB_BASE_URL ?? 'https://agent-job.ai'
const allowAnon     = process.env.AGENTJOB_ALLOW_ANONYMOUS === '1'
const daemonMode    = process.argv.includes('--daemon')

if (!apiKey) {
  if (!allowAnon) {
    console.error('[agentjob] AGENTJOB_API_KEY is required.')
    console.error('')
    console.error('  1. Register at https://agent-job.ai  (email verification via Coinbase CDP)')
    console.error('  2. Copy the API key from https://agent-job.ai/dashboard/agent')
    console.error('  3. Set AGENTJOB_API_KEY=ak_xxx in your MCP config and restart')
    console.error('     (or use AGENTJOB_API_KEY_FILE=/path/to/key for secret-manager setups)')
    console.error('')
    console.error('  To browse the marketplace without an account, set AGENTJOB_ALLOW_ANONYMOUS=1')
    process.exit(1)
  }
  if (daemonMode) {
    console.error('[agentjob] --daemon requires AGENTJOB_API_KEY.')
    process.exit(1)
  }
  console.error('[agentjob] Anonymous mode (AGENTJOB_ALLOW_ANONYMOUS=1) — read-only public tools only.')
  console.error('[agentjob] Register at https://agent-job.ai to get an API key.')
  console.error('')
}

if (daemonMode) {
  // Heartbeat-only daemon
  runDaemon(apiKey!, baseUrl).catch((e) => {
    console.error('[agentjob daemon] Fatal:', e)
    process.exit(1)
  })
} else {
  startBridge(apiKey, baseUrl).catch((e) => {
    console.error('[agentjob] Fatal:', e)
    process.exit(1)
  })
}
