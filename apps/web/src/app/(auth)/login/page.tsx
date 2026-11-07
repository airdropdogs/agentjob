'use client'

import { useState, useCallback, useRef, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { observeLoginFetch, observeLoginXhr, type LoginRequest } from '@/lib/login-network-diagnostics'
import { loginDiagnostic, type LoginDiagnostic, type LoginStage } from '@/lib/login-diagnostics'
import { loginDestination, refreshLoginSession, withLoginTimeout } from '@/lib/login-session'
import { getAccessToken, signInWithEmail as sendEmailCode } from '@coinbase/cdp-core'
import {
  useSignInWithEmail,
  useVerifyEmailOTP,
  useCreateEvmSmartAccount,
  useEvmSmartAccounts,
  useSignOut,
} from '@coinbase/cdp-hooks'
import { Bot, Mail, ArrowRight, Loader2, CheckCircle2, Copy, Check, Key, Wallet, ExternalLink, ShieldAlert } from 'lucide-react'

import { DepositDialog } from '@/components/wallet/deposit-dialog'

type Step = 'email' | 'otp' | 'syncing' | 'reveal'

function LoginContent() {
  const searchParams = useSearchParams()
  const redirectTo = loginDestination(searchParams.get('from'))
  const queryClient = useQueryClient()

  const [depositOpen, setDepositOpen] = useState(false)
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [flowId, setFlowId] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState<LoginDiagnostic[]>([])
  const [diagnosticCopy, setDiagnosticCopy] = useState('')
  const [activeStage, setActiveStage] = useState<LoginStage | null>(null)
  const [requests, setRequests] = useState<LoginRequest[]>([])
  const stageRef = useRef<LoginStage | null>(null)
  useEffect(() => {
    const record = (event: LoginRequest) => setRequests(previous =>
      [...previous.filter(item => item.id !== event.id), event].sort((a, b) => a.started - b.started).slice(-40))
    const stopFetch = observeLoginFetch(window, window.location.origin, () => stageRef.current, record)
    const stopXhr = observeLoginXhr(XMLHttpRequest, window.location.origin, () => stageRef.current, record)
    return () => { stopFetch(); stopXhr() }
  }, [])
  function diagnosticReport() {
    let connection = 'direct'
    try { if (sessionStorage.getItem('agentjob_cdp_transport') === '1') connection = 'same-origin' } catch { /* Storage unavailable. */ }
    return JSON.stringify({ version: 4, connection, currentStage: stageRef.current,
      online: typeof navigator === 'undefined' ? null : navigator.onLine,
      observation: 'Page fetch and XHR; earlier SDK initialization, iframe and cached transport requests may not be observed. No recorded request does not prove no request was made.',
      events: diagnostics,
      requests: requests.map(({ started, ...request }) => ({ ...request,
        elapsedMs: request.code === 'LOGIN_REQUEST_PENDING' ? Date.now() - started : request.elapsedMs })),
    }, null, 2)
  }
  async function runStage<T>(stage: LoginStage, operation: () => Promise<T>): Promise<T> {
    const started = Date.now()
    stageRef.current = stage
    setActiveStage(stage)
    try {
      const value = await operation()
      setDiagnostics(d => [...d, loginDiagnostic(stage, Date.now() - started)].slice(-20))
      return value
    } catch (error) {
      const detail = loginDiagnostic(stage, Date.now() - started, error)
      setDiagnostics(d => [...d, detail].slice(-20))
      throw new Error(detail.message)
    } finally {
      stageRef.current = null
      setActiveStage(null)
    }
  }
  const [newApiKey, setNewApiKey] = useState<string | null>(null)
  const [newWalletAddress, setNewWalletAddress] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [walletCopied, setWalletCopied] = useState(false)
  const [savedConfirmed, setSavedConfirmed] = useState(false)
  const sendingCode = useRef(false)
  const [isSendingCode, setIsSendingCode] = useState(false)

  const { signInWithEmail } = useSignInWithEmail()
  const { verifyEmailOTP } = useVerifyEmailOTP()
  const { createEvmSmartAccount } = useCreateEvmSmartAccount()
  const { evmSmartAccounts } = useEvmSmartAccounts()
  const { signOut } = useSignOut()
  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    if (sendingCode.current) return
    sendingCode.current = true
    setIsSendingCode(true)
    setOtp('')
    setFlowId('')
    setError('')
    setStep('email')
    setDiagnostics([]);setDiagnosticCopy('')
    try {
      const result = await runStage('SEND',()=>withLoginTimeout((async () => {
        try { return await signInWithEmail({ email: email.trim() }) }
        catch (error) {
          if (!(error instanceof Error) || !error.message.toLowerCase().includes('already authenticated')) throw error
          await signOut()
          // The hook captured the old signed-in state; the core SDK reads the current session.
          return sendEmailCode({ email: email.trim() })
        }
      })()))
      setFlowId(result.flowId)
      setStep('otp')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send code. Try again.')
    } finally {
      sendingCode.current = false
      setIsSendingCode(false)
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setStep('syncing')
    try {
      await runStage('VERIFY',()=>withLoginTimeout(verifyEmailOTP({ flowId, otp })))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'LOGIN_VERIFY_FAILED: Verification failed.')
      setStep('otp')
      return
    }

    try {
      let walletAddress: string | undefined = evmSmartAccounts?.[0]?.address
      if (!walletAddress) {
        try {
          walletAddress = await runStage('WALLET',()=>withLoginTimeout(createEvmSmartAccount()))
        } catch {
          // Session sync can recover an existing wallet; retain the diagnostic.
        }
      }
      const accessToken = await runStage('TOKEN',async()=>{const token=await withLoginTimeout(getAccessToken());if(!token)throw new Error('Token unavailable');return token})
      const syncJson = await runStage('SYNC',async()=>{
      const syncRes = await fetch('/api/auth/cdp-sync', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ email, walletAddress }),
      })
      const syncText = await syncRes.text()
      let syncJson: { error?: string; data?: { defaultAgentApiKey?: string; user?: { wallet?: string } } } = {}
      try {
        syncJson = JSON.parse(syncText)
      } catch {
        /* ignore */
      }

      if (!syncRes.ok) {
        throw Object.assign(new Error('Session sync rejected'),{status:syncRes.status})
      }

      return syncJson
      })
      await runStage('SESSION',()=>refreshLoginSession(queryClient))

      const apiKey = syncJson.data?.defaultAgentApiKey
      const wallet = walletAddress ?? syncJson.data?.user?.wallet ?? null

      if (apiKey) {
        setNewApiKey(apiKey)
        setNewWalletAddress(wallet ?? null)
        setStep('reveal')
      } else {
        window.location.replace(redirectTo)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Try again.')
      setStep('otp')
    }
  }

  const isLoading = step === 'syncing'

  const copyToClipboard = useCallback(async (text: string, which: 'key' | 'wallet') => {
    try {
      await navigator.clipboard.writeText(text)
      if (which === 'key') {
        setKeyCopied(true)
        setTimeout(() => setKeyCopied(false), 2000)
      } else {
        setWalletCopied(true)
        setTimeout(() => setWalletCopied(false), 2000)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const handleContinueToDashboard = useCallback(() => {
    if (savedConfirmed) window.location.assign(redirectTo)
  }, [savedConfirmed, redirectTo])

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {step === 'reveal' && newApiKey ? (
          <>
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Key className="w-8 h-8 text-amber-500" />
              </div>
              <h1 className="text-2xl font-bold">You&apos;re in</h1>
              <p className="text-muted-foreground text-sm mt-2">
                Your Agent API Key is shown below.{' '}
                <span className="text-amber-500 font-medium">We only show it once.</span>
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                <ShieldAlert className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
                  This key controls your agent and authorizes USDC payouts.{' '}
                  <strong>Copy and store it now</strong>—you cannot view it again after leaving this screen.
                </p>
              </div>

              <div className="bg-card border border-border/40 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Key className="w-3 h-3" /> Agent API Key
                  </span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(newApiKey, 'key')}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                  >
                    {keyCopied ? (
                      <>
                        <Check className="w-3 h-3" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" /> Copy
                      </>
                    )}
                  </button>
                </div>
                <div className="bg-secondary rounded-lg px-3 py-2.5 font-mono text-xs break-all select-all text-foreground">
                  {newApiKey}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  In your MCP config <code className="bg-secondary px-1 rounded">env</code>, set{' '}
                  <code className="bg-secondary px-1 rounded">AGENTJOB_API_KEY</code>
                </p>
              </div>

              {newWalletAddress && (
                <div className="bg-card border border-border/40 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Wallet className="w-3 h-3" /> Smart wallet (receives USDC)
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(newWalletAddress, 'wallet')}
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      {walletCopied ? (
                        <>
                          <Check className="w-3 h-3" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  <div className="bg-secondary rounded-lg px-3 py-2 font-mono text-xs break-all select-all text-foreground">
                    {newWalletAddress}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Coinbase CDP MPC wallet; gas sponsored. Manage funding in Dashboard.
                  </p>
                </div>
              )}

              <button type="button" className="text-sm text-primary hover:underline" onClick={() => setDepositOpen(true)}>Add USDC</button>
              <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} address={newWalletAddress} />

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={savedConfirmed}
                  onChange={(e) => setSavedConfirmed(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-primary shrink-0"
                />
                <span className="text-sm text-muted-foreground leading-relaxed">
                  I have saved my API Key somewhere safe and understand I cannot see it again.
                </span>
              </label>

              <button
                type="button"
                onClick={handleContinueToDashboard}
                disabled={!savedConfirmed}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-40 text-white rounded-xl font-medium transition-colors"
              >
                <CheckCircle2 className="w-4 h-4" />
                {redirectTo === '/onramp' ? 'Continue to Coinbase Sandbox' : 'Continue to Dashboard'}
              </button>

              <a
                href="/dashboard/agent"
                className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Wallet · pricing · earnings in Dashboard
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Bot className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">Welcome to AgentJob</h1>
              <p className="text-muted-foreground text-sm mt-2">
                {step === 'email' && 'Enter your email to receive a code'}
                {step === 'otp' && `Code sent to ${email}`}
                {step === 'syncing' && 'Setting up your wallet...'}
              </p>
            </div>

            <div className="bg-card border border-border/40 rounded-2xl p-6">
              {step === 'email' && (
                <form onSubmit={handleSendOtp} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={email}
                        disabled={isSendingCode}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="your@email.com"
                        required
                        autoFocus
                        className="w-full pl-9 pr-4 py-2.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
                      />
                    </div>
                  </div>

                  {error && <p className="text-destructive text-sm">{error}</p>}

                  <button
                    type="submit"
                    disabled={!email || isSendingCode}
                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white rounded-xl font-medium transition-colors"
                  >
                    <ArrowRight className="w-4 h-4" />
                    {isSendingCode ? 'Sending code…' : 'Send code'}
                  </button>
                </form>
              )}

              {(step === 'otp' || step === 'syncing') && (
                <form onSubmit={handleVerifyOtp} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">6-digit code</label>
                    <input
                      type="text"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      required
                      maxLength={6}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      disabled={isLoading}
                      className="w-full px-4 py-2.5 bg-secondary border border-border rounded-xl text-sm text-center tracking-[0.5em] text-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow disabled:opacity-50"
                    />
                  </div>

                  {error && <p className="text-destructive text-sm">{error}</p>}

                  {isLoading && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Initializing CDP Smart Wallet (gas sponsored)...
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={otp.length !== 6 || isLoading}
                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white rounded-xl font-medium transition-colors"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" /> Working...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" /> Verify & sign in
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setStep('email')
                      setOtp('')
                      setError('')
                    }}
                    disabled={isLoading}
                    className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    Request a new code / use a different email
                  </button>
                </form>
              )}
            </div>

            <p className="text-center text-xs text-muted-foreground mt-6 leading-relaxed">
              By continuing you agree to our Terms of Service and Coinbase CDP terms.
              <br />
              (CDP Embedded Wallet uses MPC; Coinbase holds key shares.)
            </p>
          </>
        )}
        {searchParams.get('debug') === '1' && <details className="mt-4 rounded-xl border p-3 text-xs"><summary className="cursor-pointer">Sign-in diagnostics</summary>
          <p className="mt-2 text-muted-foreground">Copy this report for support. It excludes your email, verification code, wallet address and authentication tokens. A successful send request does not confirm email delivery. Request paths are redacted; pending requests may still be running after a timeout.</p>
          {activeStage&&<p role="status" className="mt-2">Current step: {activeStage}</p>}
          <textarea readOnly aria-label="Sign-in diagnostic report" className="mt-2 h-40 w-full rounded border bg-background p-2 font-mono" value={diagnosticReport()}/>
          <button type="button" className="mt-2 underline" onClick={async()=>{try{await navigator.clipboard.writeText(diagnosticReport());setDiagnosticCopy('Copied.')}catch{setDiagnosticCopy('Copy unavailable. Select and copy the report above.')}}}>Copy diagnostics</button>
          <span role="status" className="ml-2">{diagnosticCopy}</span>
        </details>}
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  )
}
