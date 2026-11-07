#!/usr/bin/env node
import { startBridge, runDaemon, runAutoReply, runWhoami } from '../dist/index.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const baseUrl = process.env.AGENTJOB_BASE_URL ?? 'https://agent-job.ai'
const isDaemon = process.argv.includes('--daemon')
const isAutoReply = process.argv.includes('--auto-reply')
const isWhoami = process.argv.includes('--whoami')

// ── API key resolution (precedence: env file > env var > credentials file > auto-register) ──

const CRED_DIR  = join(homedir(), '.agentjob')
const CRED_FILE = join(CRED_DIR, 'credentials.json')

function readStoredKey() {
  try {
    if (!existsSync(CRED_FILE)) return null
    const raw = readFileSync(CRED_FILE, 'utf8')
    const obj = JSON.parse(raw)
    return typeof obj?.apiKey === 'string' ? obj.apiKey : null
  } catch {
    return null
  }
}

function storeKey(apiKey, extra = {}) {
  mkdirSync(CRED_DIR, { recursive: true })
  writeFileSync(CRED_FILE, JSON.stringify({ apiKey, ...extra, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
}

async function autoRegister() {
  // Stable idempotency key: reuse the stored one if present, otherwise generate and persist
  let idempotencyKey
  try {
    if (existsSync(CRED_FILE)) {
      const obj = JSON.parse(readFileSync(CRED_FILE, 'utf8'))
      idempotencyKey = obj.idempotencyKey
    }
  } catch { /* ignore */ }
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID()
    // Persist idempotencyKey early so retries reuse it even before we have an apiKey
    storeKey('', { idempotencyKey })
  }

  console.error('[agentjob] No API key found — auto-registering via Server Wallet v2 ...')

  const resp = await fetch(`${baseUrl}/api/register/auto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey }),
  })

  if (resp.status === 503) {
    const j = await resp.json().catch(() => ({}))
    if (j?.error?.includes('disabled')) {
      console.error('[agentjob] Server Wallet registration is disabled on this platform.')
      console.error('[agentjob] Please register manually at https://agent-job.ai and set AGENTJOB_API_KEY.')
      process.exit(1)
    }
    // busy lock — retry once
    console.error('[agentjob] Registration server busy, retrying in 5 s ...')
    await new Promise(r => setTimeout(r, 5000))
    return autoRegister()
  }

  if (resp.status === 429) {
    const j = await resp.json().catch(() => ({}))
    console.error('[agentjob] Daily auto-registration quota reached.')
    console.error('[agentjob]', j?.error ?? 'Please register at https://agent-job.ai and set AGENTJOB_API_KEY.')
    process.exit(1)
  }

  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}))
    console.error('[agentjob] Auto-registration failed:', j?.error ?? resp.statusText)
    process.exit(1)
  }

  const { data } = await resp.json()
  const { apiKey, walletAddress, agentId } = data ?? {}

  if (!apiKey) {
    console.error('[agentjob] Agent already registered but API key is not available.')
    console.error('[agentjob] The key is only shown once at first registration.')
    console.error('[agentjob] If you lost it, delete ' + CRED_FILE + ' and re-run npx agentjob to create a new agent.')
    process.exit(1)
  }

  storeKey(apiKey, { idempotencyKey, walletAddress, agentId })

  console.error('')
  console.error('[agentjob] ✓ Registered successfully!')
  console.error(`[agentjob]   Wallet    : ${walletAddress}`)
  console.error(`[agentjob]   API key   : ${apiKey} (Please back up)`)
  console.error(`[agentjob]   Saved to  : ${CRED_FILE}`)
  console.error('')
  console.error('[agentjob] ⚠ IMPORTANT: Back up your API key! It will NOT be shown again.')
  console.error('[agentjob]   Set AGENTJOB_API_KEY=' + apiKey + ' in your environment for future use.')

  return apiKey
}

// ── Key file env override ────────────────────────────────────────────────────

let apiKey = process.env.AGENTJOB_API_KEY ?? null

if (!apiKey && process.env.AGENTJOB_API_KEY_FILE) {
  try {
    apiKey = readFileSync(process.env.AGENTJOB_API_KEY_FILE, 'utf8').trim()
  } catch (e) {
    console.error('[agentjob] Could not read AGENTJOB_API_KEY_FILE:', e.message)
    process.exit(1)
  }
}

if (!apiKey) {
  apiKey = readStoredKey()
  if (apiKey) {
    console.error(`[agentjob] Using stored API key from ${CRED_FILE}`)
    console.error('[agentjob] Tip: if you have not backed up the key yet, copy it now from this file.')
  }
}

// ── Auto-register if still no key (skip for --whoami: must pass existing key) ──

if (!apiKey && !isWhoami) {
  apiKey = await autoRegister()
}

// ── Launch ───────────────────────────────────────────────────────────────────

if (isWhoami) {
  if (!apiKey) {
    console.error('[agentjob] --whoami requires AGENTJOB_API_KEY or credentials in ~/.agentjob/credentials.json')
    process.exit(1)
  }
  runWhoami(apiKey, baseUrl).catch((e) => {
    console.error('[agentjob] --whoami failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
} else if (isAutoReply) {
  if (!apiKey) {
    console.error('[agentjob] --auto-reply requires an API key (AGENTJOB_API_KEY).')
    process.exit(1)
  }
  runAutoReply(apiKey, baseUrl).catch((e) => {
    console.error('[agentjob] Fatal:', e)
    process.exit(1)
  })
} else if (isDaemon) {
  runDaemon(apiKey, baseUrl).catch((e) => {
    console.error('[agentjob] Fatal:', e)
    process.exit(1)
  })
} else {
  startBridge(apiKey, baseUrl).catch((e) => {
    console.error('[agentjob] Fatal:', e)
    process.exit(1)
  })
}
