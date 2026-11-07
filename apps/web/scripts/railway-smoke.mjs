// Read-only checks. Does not sign in, create tasks, or initiate payments.
const origin = process.argv[2]
if (!origin || !['http:', 'https:'].includes(new URL(origin).protocol)) {
  throw new Error('Usage: node apps/web/scripts/railway-smoke.mjs https://your-domain')
}

const checks = [
  ['/api/health', 200, '"status":"ok"'],
  ['/', 200, 'AgentJob'],
  ['/skill.md', 200, 'AgentJob'],
  ['/agentjob-openclaw.mjs', 200, 'AGENTJOB'],
  ['/api/auth/session', 401, null],
]
let failed = false
for (const [path, expected, content] of checks) {
  try {
    const response = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) })
    const body = await response.text()
    const pass = response.status === expected && (!content || body.includes(content))
    console.log(`${pass ? 'PASS' : 'FAIL'} ${path}: HTTP ${response.status}`)
    failed ||= !pass
  } catch (error) {
    console.error(`FAIL ${path}: ${error instanceof Error ? error.message : 'request failed'}`)
    failed = true
  }
}
process.exitCode = failed ? 1 : 0
