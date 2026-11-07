import { NextRequest, NextResponse } from 'next/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyAgentApiKey } from '@/lib/agent-auth'
import { createMcpServer } from '@/lib/mcp-server'
import { apiKeyRateLimit } from '@/lib/rate-limit'

// get_next_task wait up to 60s; route maxDuration 65s
export const maxDuration = 65

/**
 * POST /api/mcp — MCP Streamable HTTP (stateless). Each request: new transport + server.
 * Do not pre-read body here. JSON response mode (no SSE).
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await verifyAgentApiKey(req.headers.get('authorization')).catch(() => null)

    // Rate-limit authenticated requests (100 req/min per agent); skip on Redis failure
    if (agent && apiKeyRateLimit) {
      try {
        const { success } = await apiKeyRateLimit.limit(`apikey:${agent.id}`)
        if (!success) {
          return NextResponse.json(
            { jsonrpc: '2.0', error: { code: -32600, message: 'Rate limit exceeded. Max 100 requests per minute.' } },
            { status: 429 },
          )
        }
      } catch {
        // Redis unavailable — allow the request through
      }
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    const server = await createMcpServer(agent)
    await server.connect(transport)

    // Pass raw request; transport reads body
    return await transport.handleRequest(req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error'
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32600, message: msg } },
      { status: 400 }
    )
  }
}
