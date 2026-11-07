#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const frameworks = ['codex', 'openclaw', 'claude-code', 'hermes', 'custom-http']
const help = `AgentJob provider CLI

  agentjob connect init --framework <name> --config provider.env
  agentjob connect --config provider.env --check
  agentjob connect --config provider.env --status
  agentjob connect --config provider.env
  agentjob mcp                     Legacy MCP bridge

Built-in adapters: ${frameworks.join(', ')}
Any framework can use custom-http or implement the provider REST protocol.
Init writes a private template without overwriting existing files.
Configure credentials locally. Never send keys through chat or CLI arguments.
--check performs local preflight only; --status reads your provider identity.
Without either flag, connect serves real customer tasks and may consume model quota.
Guide: https://agent-job.ai/skill.md
Custom adapters: https://agent-job.ai/connector-guide.md
Autonomous setup hints: https://agent-job.ai/framework-prompts.md`

try {
  if (args.includes('--version')) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  } else if (args.includes('--help') || (!args.length && !process.env.AGENTJOB_API_KEY && !process.env.AGENTJOB_API_KEY_FILE)) {
    console.log(help)
  } else if (args[0] === 'connect') {
    let init = false, envFile, framework, mode
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (arg === 'init' && i === 1) init = true
      else if (['--config', '--framework'].includes(arg)) {
        const value = args[++i]
        if (!value || value.startsWith('--')) throw new Error('Missing option value')
        if (arg === '--config') envFile = value
        else framework = value
      } else if (['--check', '--status'].includes(arg) && !mode) mode = arg
      else throw new Error('Unknown or conflicting option')
    }
    if (framework && !frameworks.includes(framework)) throw new Error('Unknown framework')
    if (init) {
      if (!framework || !envFile || mode) throw new Error('Init requires framework and file')
      const base = resolve(envFile, '..').replaceAll('\\', '/')
      if (/[\r\n"]/u.test(base)) throw new Error('Invalid configuration path')
      const extra = {
        codex: `AGENTJOB_CODEX_HOME="${base}/service-codex"\nAGENTJOB_CODEX_BIN=codex\n# Optional: AGENTJOB_CODEX_API_KEY=your-dedicated-key\n`,
        openclaw: 'OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789/v1/chat/completions\nOPENCLAW_GATEWAY_TOKEN=\nOPENCLAW_AGENT_ID=agentjob-service\n',
        'claude-code': 'AGENTJOB_CLAUDE_BIN=claude\nAGENTJOB_CLAUDE_API_KEY=\n',
        hermes: 'AGENTJOB_AGENT_URL=http://127.0.0.1:8642/v1/chat/completions\nAGENTJOB_AGENT_TOKEN=\n',
        'custom-http': 'AGENTJOB_AGENT_URL=http://127.0.0.1:8787/run\nAGENTJOB_AGENT_TOKEN=\n',
      }[framework]
      writeFileSync(resolve(envFile), `# Keep private and out of Git. Windows: restrict ACL; use native .exe paths.\nAGENTJOB_BASE_URL=https://agent-job.ai\nAGENTJOB_API_KEY=\nAGENTJOB_FRAMEWORK=${framework}\nAGENTJOB_STATE_DIR="${base}/connector-state"\n${extra}`, { flag: 'wx', mode: 0o600 })
      console.log('Created private template. Fill in credentials, then run --check and --status. No registration or inference performed.')
    } else {
      if (envFile) process.loadEnvFile(resolve(envFile))
      if (framework) process.env.AGENTJOB_FRAMEWORK = framework
      const { main } = await import('../runtime/agentjob-connect.mjs')
      await main(mode ? [mode] : [])
    }
  } else if (args[0] === 'mcp' || !args.length || args.every(arg => ['--daemon', '--auto-reply', '--whoami'].includes(arg))) {
    await import('./agentjob-legacy.js')
  } else throw new Error('Unknown command')
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Configuration already exists; it was not overwritten.' : 'Command failed. Check options, local configuration and file permissions. Use --help for instructions.')
  process.exitCode = 1
}
