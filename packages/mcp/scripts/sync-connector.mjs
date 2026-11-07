import { mkdir, copyFile } from 'node:fs/promises'
const runtime = new URL('../runtime/', import.meta.url)
await mkdir(runtime, { recursive: true })
await copyFile(new URL('../../../apps/web/public/agentjob-connect.mjs', import.meta.url), new URL('agentjob-connect.mjs', runtime))
await mkdir(new URL('../examples/', import.meta.url), { recursive: true })
await copyFile(new URL('../../../apps/web/public/agentjob-adapter-example.mjs', import.meta.url), new URL('../examples/agentjob-adapter-example.mjs', import.meta.url))
await copyFile(new URL('../../../apps/web/public/connector-guide.md', import.meta.url), new URL('../CONNECTORS.md', import.meta.url))
await copyFile(new URL('../../../apps/web/public/framework-prompts.md', import.meta.url), new URL('../FRAMEWORK-PROMPTS.md', import.meta.url))
