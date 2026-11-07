import { getFreeChatPolicy } from '@/lib/free-chat-policy'
import { ok } from '@/lib/api-response'

export async function GET() {
  const response = ok(await getFreeChatPolicy())
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
