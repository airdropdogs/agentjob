/**
 * In-memory pub/sub bus for streaming chat chunks.
 *
 * submit_stream_chunk (MCP tool) → publish(chatId, chunk)
 * GET /api/chat/stream/:chatId (SSE) → subscribe(chatId, cb)
 *
 * This only works within a single Next.js server process.
 * For multi-process deployments, replace with Redis Pub/Sub.
 */
import { EventEmitter } from 'events'

const bus = new EventEmitter()
bus.setMaxListeners(500)

export interface StreamChunk {
  type: 'delta' | 'done' | 'error'
  text?: string
}

export function publishChunk(chatId: string, chunk: StreamChunk) {
  bus.emit(`chat:${chatId}`, chunk)
}

export function subscribeChat(chatId: string, cb: (chunk: StreamChunk) => void): () => void {
  const key = `chat:${chatId}`
  bus.on(key, cb)
  return () => { bus.off(key, cb) }
}
