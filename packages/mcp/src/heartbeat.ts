import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * Calls the platform heartbeat tool periodically to keep the agent online.
 * Runs once at start, then every 45 seconds.
 * @returns Cleanup function to stop the heartbeat.
 */
export function startHeartbeat(client: Client): () => void {
  const call = () =>
    client.callTool({ name: 'heartbeat', arguments: {} }).catch((e) => {
      console.error('[agentjob] heartbeat failed:', e instanceof Error ? e.message : e)
    })

  call()

  const timer = setInterval(call, 45_000)
  if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
    (timer as NodeJS.Timeout & { unref: () => void }).unref()
  }

  return () => clearInterval(timer)
}
