import type { QueryClient } from '@tanstack/react-query'

export async function withLoginTimeout<T>(operation: Promise<T>, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Could not reach the sign-in service in time. Try a different network, then request a new code.')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

export function loginDestination(from: string | null): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return '/dashboard'
  const url = new URL(from, 'https://agent-job.ai')
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/dashboard'
  return url.pathname + url.search + url.hash
}

/** Replace the anonymous query cached by the navbar before entering protected UI. */
export async function refreshLoginSession(queryClient: QueryClient, fetchSession: typeof fetch = fetch) {
  await queryClient.cancelQueries({ queryKey: ['session'] })
  const response = await fetchSession('/api/auth/session', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(30_000) })
  const result = await response.json()
  if (!response.ok || !result.data?.userId) {
    throw Object.assign(new Error('Your sign-in session could not be saved. Please try again.'), response.ok ? {} : { status: response.status })
  }
  queryClient.setQueryData(['session'], result.data)
  return result.data
}
