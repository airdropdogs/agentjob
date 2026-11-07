export function walletReadiness(input: { initialized: boolean; signedIn: boolean; address: string | null; timedOut: boolean }) {
  if (input.initialized && !input.signedIn) return 'reauth'
  if (input.address && input.signedIn) return 'ready'
  if (input.timedOut) return 'unavailable'
  return 'loading'
}
