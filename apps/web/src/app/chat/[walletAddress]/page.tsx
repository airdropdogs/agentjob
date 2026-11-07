'use client'

import { use, useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useX402, useCurrentUser, useIsSignedIn } from '@coinbase/cdp-hooks'
import {
  AlertCircle, CheckCircle2, Wallet, ArrowRight, Loader2,
  Plus, PanelLeftClose, PanelLeftOpen, Trash2, FileQuestion,
  ChevronDown, Search, Sun, Moon, LayoutDashboard,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useDarkMode } from '@/components/layout/navbar'
import { cn, formatUsdc } from '@/lib/utils'
import { CHAT_PAYMENT_MAX_MICRO, readPaymentQuote, samePaymentQuote, submitChatPayment, type PaymentPhase, type PaymentQuote, type ChatEligibility, type PaymentScope, type PaymentGrant, paymentScope, grantMatches, createPaymentGrant, reserveMessage, quoteMatchesScope } from '@/lib/chat-payment'
import { DepositDialog } from '@/components/wallet/deposit-dialog'
import { assertPaymentBalance } from '@/lib/wallet-funding'
import { ThreadPrimitive } from '@assistant-ui/react'
import { Popover } from '@base-ui/react/popover'
import { ChatRuntime, ChatMessages, ChatComposer } from '@/components/chat/assistant-chat'

// ── Types ──────────────────────────────────────────────────────────────────

interface Agent {
  id: string
  name: string
  priceSubsequent: string
  freeDailyMax: number
  freeSlotsRemaining: number | null
  dailyReplyLimit: number
  slotHint?: string
  online: boolean
  hasReputationNft: boolean
  maxConcurrentChats: number
  walletAddress?: string | null
}

interface SessionUser {
  userId: string
  email: string
  wallet?: string
  role?: 'user' | 'admin'
}

interface StoredMessage {
  attachments?: import('@/lib/attachment-policy').ChatAttachment[]
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface StoredChat {
  id: string
  agentWallet: string
  agentName: string
  title: string
  createdAt: number
  messages: StoredMessage[]
}

type ChatStatus = 'idle' | 'sending' | 'waiting' | 'error'
type PendingMessage = { key: string; chatId: string; messages: StoredMessage[]; quotes: Partial<Record<PaymentPhase, PaymentQuote>>; paymentAttempted?: boolean; accepted?: { chatId: string; taskId: string } }

// ── localStorage helpers ───────────────────────────────────────────────────

const STORAGE_KEY = 'agentjob_chat_history'
const MAX_STORED = 100

function loadAllHistory(): StoredChat[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch { return [] }
}

function saveChat(chat: StoredChat) {
  const history = loadAllHistory()
  const idx = history.findIndex(c => c.id === chat.id)
  if (idx >= 0) history[idx] = chat
  else history.unshift(chat)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_STORED)))
}

function removeChat(id: string) {
  const history = loadAllHistory().filter(c => c.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
}

function groupByDate(chats: StoredChat[]): { label: string; items: StoredChat[] }[] {
  const now = Date.now()
  const DAY = 86_400_000
  const groups: Record<string, StoredChat[]> = {}
  for (const chat of chats) {
    const diff = now - chat.createdAt
    const label =
      diff < DAY         ? 'Today' :
      diff < 2 * DAY     ? 'Yesterday' :
      diff < 7 * DAY     ? 'This week' :
      diff < 30 * DAY    ? 'This month' : 'Older'
    ;(groups[label] ??= []).push(chat)
  }
  return ['Today', 'Yesterday', 'This week', 'This month', 'Older']
    .filter(l => groups[l])
    .map(l => ({ label: l, items: groups[l] }))
}

/** Unique message id */
function genId() {
  return crypto.randomUUID()
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ChatPage({ params }: { params: Promise<{ walletAddress: string }> }) {
  const { walletAddress } = use(params)

  const [chatId, setChatId] = useState(() => crypto.randomUUID())
  const createdAtRef = useRef(Date.now())

  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [progress, setProgress] = useState<{ message: string; percent?: number } | null>(null)
  const [chatStatus, setChatStatus] = useState<ChatStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [errorNoticeHidden, setErrorNoticeHidden] = useState(false)
  useEffect(() => { setErrorNoticeHidden(false) }, [errorMsg, chatStatus])
  const navigationRef = useRef(0)
  const resumedScopeRef = useRef('')
  const [rawX402Error, setRawX402Error] = useState('')
  const [walletReady, setWalletReady] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)')
    const syncSidebar = () => setSidebarOpen(false)
    syncSidebar()
    desktop.addEventListener('change', syncSidebar)
    return () => desktop.removeEventListener('change', syncSidebar)
  }, [])
  const [history, setHistory] = useState<StoredChat[]>([])
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const { dark, toggle: toggleTheme } = useDarkMode()
  const [appealOpen, setAppealOpen] = useState(false)
  const [appealReason, setAppealReason] = useState('')
  const [appealMsg, setAppealMsg] = useState('')
  const [lastMsgIsFree, setLastMsgIsFree] = useState(false)
  const [liveSlotHint, setLiveSlotHint] = useState<string | undefined>()
  const [depositOpen, setDepositOpen] = useState(false)
  const pendingMessageRef = useRef<PendingMessage | null>(null)
  const [savedRequests, setSavedRequests] = useState<PendingMessage[]>([])
  const [hiddenSavedKeys, setHiddenSavedKeys] = useState<string[]>([])
  const sendingRef = useRef(false)
  const approvedPaymentRef = useRef<{ key: string; phase: PaymentPhase; quote: PaymentQuote } | null>(null)
  const [paymentConfirmation, setPaymentConfirmation] = useState<{ scope: PaymentScope; remainingBudgetMicro: string } | null>(null)
  const grantRef = useRef<PaymentGrant | null>(null)
  const [paymentGrant, setPaymentGrant] = useState<PaymentGrant | null>(null)
  const payerRef = useRef('')
  function revokePaymentGrant() {
    grantRef.current = null
    setPaymentGrant(null)
    approvedPaymentRef.current = null
    decidePayment(false)
  }
  const paymentDecisionRef = useRef<((confirmed: boolean) => void) | null>(null)
  function decidePayment(confirmed: boolean) {
    paymentDecisionRef.current?.(confirmed)
    paymentDecisionRef.current = null
    setPaymentConfirmation(null)
  }
  useEffect(() => () => paymentDecisionRef.current?.(false), [])
  const guardedPaymentFetch = useCallback<typeof fetch>(async (input, init) => {
    const approved = approvedPaymentRef.current
    const grant = grantRef.current
    if (!grant || !grantMatches(grant, grant.scope) || grant.scope.payer !== payerRef.current.toLowerCase() || !approved || !grant.reserved[approved.key]) {
      throw new Error('Payment authorization expired or was revoked')
    }
    if (!approved || new Headers(init?.headers).get('Idempotency-Key') !== approved.key ||
        typeof init?.body !== 'string' || JSON.parse(init.body).payment_target !== approved.phase) {
      throw new Error('Payment requires a new confirmation')
    }
    const response = await fetch(input, init)
    if (response.status === 402 && !samePaymentQuote(approved.quote, await readPaymentQuote(response))) {
      throw new Error('Payment details changed. Review this message again before signing.')
    }
    if (grantRef.current !== grant || !grantMatches(grant, grant.scope) || grant.scope.payer !== payerRef.current.toLowerCase()) {
      throw new Error('Payment authorization expired or was revoked')
    }
    return response
  }, [])

  // Typewriter animation state
  const [typingMsgId, setTypingMsgId] = useState<string | null>(null)
  const [typingText, setTypingText] = useState('')
  const typingFullTextRef = useRef('')
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Animate typing: reveal text progressively when typingMsgId is set
  const startTypewriter = useCallback((msgId: string, fullText: string) => {
    if (typingTimerRef.current) clearInterval(typingTimerRef.current)
    typingFullTextRef.current = fullText
    setTypingMsgId(msgId)
    setTypingText('')
    let pos = 0
    typingTimerRef.current = setInterval(() => {
      const step = Math.min(8, typingFullTextRef.current.length - pos)
      pos += step
      setTypingText(typingFullTextRef.current.slice(0, pos))
      if (pos >= typingFullTextRef.current.length) {
        if (typingTimerRef.current) clearInterval(typingTimerRef.current)
        typingTimerRef.current = null
        setTypingMsgId(null)
      }
    }, 20)
  }, [])


  /** Poll abort */
  const pollAbortRef = useRef<AbortController | null>(null)

  const qc = useQueryClient()

  // ── session ────────────────────────────────────────────────
  const { data: session } = useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })

  const pendingStorageKey = `agentjob_pending:${session?.userId ?? ''}:${walletAddress}`
  const savedStorageKey = `${pendingStorageKey}:saved`
  useEffect(() => {
    setSavedRequests([])
    if (!session?.userId) return
    try {
      const stored = JSON.parse(sessionStorage.getItem(savedStorageKey) ?? '[]')
      if (Array.isArray(stored)) setSavedRequests(stored.filter(p => p?.key && p.chatId && Array.isArray(p.messages)))
    } catch { /* Invalid local data must not initiate requests. */ }
  }, [savedStorageKey, session?.userId])

  function restoreRequest(pending: PendingMessage) {
    if (sendingRef.current || pendingMessageRef.current) return
    navigationRef.current++
    try {
      persistPending(pending)
      const remaining = savedRequests.filter(p => p.key !== pending.key)
      sessionStorage.setItem(savedStorageKey, JSON.stringify(remaining))
      setSavedRequests(remaining)
    } catch { setErrorMsg('Could not restore this request. Please try again.'); return }
    pollAbortRef.current?.abort()
    pendingMessageRef.current = pending
    setChatId(pending.chatId)
    setMessages(pending.messages)
    setChatStatus('error')
    setErrorMsg('Request restored. Retry uses the original payment request; restoring does not send or pay.')
  }
  function ignoreSavedRequest(key: string) {
    setHiddenSavedKeys(current => [...current, key])
  }
  function persistPending(pending: PendingMessage) {
    sessionStorage.setItem(pendingStorageKey, JSON.stringify(pending))
  }
  function clearPending() {
    pendingMessageRef.current = null
    sessionStorage.removeItem(pendingStorageKey)
    void refetchEligibility()
  }
  useEffect(() => {
    if (!session?.userId) return
    try {
      const pending = JSON.parse(sessionStorage.getItem(pendingStorageKey) ?? 'null') as PendingMessage | null
      if (!pending?.key || !pending.chatId || !Array.isArray(pending.messages)) return
      const stored = JSON.parse(sessionStorage.getItem(savedStorageKey) ?? '[]')
      const saved = [...(Array.isArray(stored) ? stored.filter(p => p?.key && p.chatId && Array.isArray(p.messages) && p.key !== pending.key) : []), pending]
      sessionStorage.setItem(savedStorageKey, JSON.stringify(saved))
      sessionStorage.removeItem(pendingStorageKey)
      setSavedRequests(saved)
    } catch { /* A malformed local draft must not trigger a payment. */ }
  }, [session?.userId, pendingStorageKey, savedStorageKey])

  // ── CDP hooks ──────────────────────────────────────────────
  const { isSignedIn } = useIsSignedIn()
  const { currentUser } = useCurrentUser()
  const payer = currentUser?.evmSmartAccountObjects?.[0]?.address ?? currentUser?.evmAccountObjects?.[0]?.address ?? ''
  useEffect(() => {
    payerRef.current = payer
    if (grantRef.current && grantRef.current.scope.payer !== payer.toLowerCase()) revokePaymentGrant()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payer])
  const { fetchWithPayment } = useX402({ maxValue: CHAT_PAYMENT_MAX_MICRO, fetch: guardedPaymentFetch, address: payer || undefined })

  useEffect(() => {
    setWalletReady(!!isSignedIn && !!currentUser)
  }, [isSignedIn, currentUser])

  // Wallet balance
  const { data: walletBalance, isError: balanceError, isFetching: balanceFetching, refetch: refreshBalance } = useQuery<{ usdc: string; smartWallet: string }>({
    queryKey: ['wallet-balance', session?.wallet],
    queryFn: async () => {
      const res = await fetch('/api/wallet/balance', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      const { data } = await res.json()
      if (!res.ok || data?.smartWallet?.toLowerCase() !== session?.wallet?.toLowerCase() ||
        typeof data?.usdc !== 'string' || !/^\d+(\.\d+)?$/.test(data.usdc)) throw new Error('Balance unavailable')
      return data
    },
    enabled: !!session?.userId && !!session.wallet,
    retry: 1,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const balanceLabel = balanceError ? 'Balance unavailable' : walletBalance ? `${walletBalance.usdc} USDC` : session?.wallet ? 'Loading balance…' : 'Wallet initializing…'

  // ── agent info ─────────────────────────────────────────────
  const { data: agent } = useQuery<Agent>({
    queryKey: ['agent', walletAddress],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${walletAddress}`)
      const json = await res.json()
      return json.data
    },
    refetchInterval: 15_000,
  })

  // ── load history on mount ──────────────────────────────────
  const { data: eligibility, refetch: refetchEligibility, isPending: eligibilityLoading } = useQuery<ChatEligibility | null>({
    queryKey: ['chat-eligibility', agent?.id, chatId, session?.userId],
    enabled: !!agent?.id,
    queryFn: async () => {
      const response = await fetch('/api/chat/eligibility?' + new URLSearchParams({ agent_id: agent!.id, chat_id: chatId }), { cache: 'no-store' })
      if (!response.ok) return null
      return response.json()
    },
    refetchInterval: 15_000,
  })
  const freeEligible = eligibility?.eligible === true
  const freeMessagesRemaining = eligibility?.freeMessagesRemaining
  const freeMessageLabel = `This message is free${typeof freeMessagesRemaining === 'number' ? ` / up to ${freeMessagesRemaining} remaining today with this Agent` : ''}`
  const freeAlreadyUsed = ['agent_free_used', 'user_daily_limit', 'agent_daily_limit'].includes(eligibility?.reason ?? '')
  const unknownEligibilityMessage = eligibilityLoading ? 'Checking free eligibility...' : session ? 'Could not check free eligibility. Try again.' : 'Sign in to check free eligibility.'
  const eligibilityKnown = typeof eligibility?.eligible === 'boolean'
  const priceLabel = eligibility?.priceMicro ? formatUsdc(Number(eligibility.priceMicro) / 1_000_000) : formatUsdc(agent?.priceSubsequent ?? '0')
  const messageCostLabel = freeEligible
    ? `Free${typeof freeMessagesRemaining === 'number' ? ` / up to ${freeMessagesRemaining}` : ''}`
    : eligibilityKnown ? `${priceLabel} USDC` : 'Checking price…'
  useEffect(() => {
    if (grantRef.current && grantRef.current.scope.agentId !== agent?.id) revokePaymentGrant()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id])
  useEffect(() => {
    if (!paymentGrant) return
    const timer = setTimeout(() => revokePaymentGrant(), Math.max(0, paymentGrant.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentGrant?.expiresAt])

  const refreshHistory = useCallback(() => {
    setHistory(loadAllHistory().filter(c => c.agentWallet === walletAddress))
  }, [walletAddress])

  useEffect(() => { refreshHistory() }, [refreshHistory])

  // Sync DB history to localStorage
  useEffect(() => {
    if (!session) return
    let cancelled = false
    const navigation = navigationRef.current
    const scope = `${session.userId}:${walletAddress.toLowerCase()}`
    fetch(`/api/chat/history?agentWallet=${encodeURIComponent(walletAddress)}`)
      .then(r => r.ok ? r.json() : null)
      .then((json) => {
        if (cancelled || !Array.isArray(json?.data)) return
        const dbChats: Array<{
          id: string; agentWallet: string | null; agentName: string;
          title: string; createdAt: string
        }> = json.data
        const local = loadAllHistory()
        let changed = false
        for (const dc of dbChats) {
          if (!dc.agentWallet || dc.agentWallet.toLowerCase() !== walletAddress.toLowerCase()) continue
          const existing = local.find(c => c.id === dc.id)
          if (!existing) {
            local.unshift({
              id: dc.id,
              agentWallet: dc.agentWallet,
              agentName: dc.agentName,
              title: dc.title,
              createdAt: new Date(dc.createdAt).getTime(),
              messages: [],
            })
            changed = true
          }
        }
        if (changed) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(local.slice(0, MAX_STORED)))
          setHistory(local.filter(c => c.agentWallet === walletAddress))
        }
        if (resumedScopeRef.current !== scope) {
          resumedScopeRef.current = scope
          const latest = dbChats[0]
          if (latest && navigationRef.current === navigation && !sendingRef.current && !pendingMessageRef.current && messages.length === 0) {
            loadChat({ id: latest.id, agentWallet: walletAddress, agentName: latest.agentName, title: latest.title,
              createdAt: new Date(latest.createdAt).getTime(), messages: [] })
          }
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, walletAddress])

  // ── persist messages to localStorage ──────────────────────
  const agentNameRef = useRef(agent?.name)
  useEffect(() => { agentNameRef.current = agent?.name }, [agent?.name])

  useEffect(() => {
    if (messages.length === 0) return
    const title = messages.find(m => m.role === 'user')?.content?.slice(0, 50) ?? 'New chat'
    saveChat({
      id: chatId,
      agentWallet: walletAddress,
      agentName: agentNameRef.current ?? walletAddress,
      title,
      createdAt: createdAtRef.current,
      messages,
    })
    refreshHistory()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // Stream & poll chat result via SSE (typewriter effect)
  async function pollResult(cid: string, taskId: string, signal: AbortSignal) {
    setProgress(null)
    // Try SSE streaming first
    try {
      const eventSource = new EventSource(`/api/chat/stream/${cid}?taskId=${encodeURIComponent(taskId)}`)
      let accumulated = ''
      let streamingMsgId: string | null = null
      let resolveAbort: (() => void) | undefined
      const abort = () => { cleanup(); resolveAbort?.() }

      const cleanup = () => {
        try { eventSource.close() } catch {}
        signal.removeEventListener('abort', abort)
      }
      signal.addEventListener('abort', abort, { once: true })

      await new Promise<void>((resolve, reject) => {
        resolveAbort = resolve
        if (signal.aborted) { abort(); return }
        eventSource.onmessage = (event) => {
          try {
            const chunk = JSON.parse(event.data)

            if (chunk.type === 'progress') setProgress(chunk.progress)
            if (chunk.type === 'cancelled') { clearPending(); setChatStatus('idle'); setProgress(null); cleanup(); resolve(); return }
            if (chunk.type === 'delta' && chunk.text) {
              accumulated += chunk.text
              if (!streamingMsgId) {
                streamingMsgId = genId()
                setMessages(prev => [...prev, { id: streamingMsgId!, role: 'assistant', content: accumulated }])
              } else {
                setMessages(prev =>
                  prev.map(m => m.id === streamingMsgId ? { ...m, content: accumulated } : m)
                )
              }
            }

            if (chunk.type === 'done') {
              const finalText = chunk.text || accumulated
              const newId = streamingMsgId || genId()
              if (streamingMsgId) {
                setMessages(prev =>
                  prev.map(m => m.id === streamingMsgId ? { ...m, content: finalText, attachments: chunk.attachments ?? [] } : m)
                )
              } else {
                setMessages(prev => [...prev, { id: newId, role: 'assistant', content: finalText, attachments: chunk.attachments ?? [] }])
              }
              if (!streamingMsgId) startTypewriter(newId, finalText)
              clearPending()
              setChatStatus('idle')
              setErrorMsg('')
              cleanup()
              resolve()
            }

            if (chunk.type === 'error') {
              setChatStatus('error')
              setErrorMsg('The agent did not respond in time. You can try again or file an appeal.')
              cleanup()
              resolve()
            }
          } catch {}
        }

        eventSource.onerror = () => {
          cleanup()
          // SSE failed, fall back to polling
          reject(new Error('sse_failed'))
        }
      })
      return
    } catch {
      // SSE not available or failed, fall back to polling
    }

    // Fallback: classic polling
    const POLL_INTERVAL = 3000
    const TIMEOUT = 32 * 60 * 1000
    const deadline = Date.now() + TIMEOUT

    while (Date.now() < deadline) {
      if (signal.aborted) return

      try {
        const res = await fetch(`/api/chat/result/${cid}?taskId=${encodeURIComponent(taskId)}`, { signal, credentials: 'include' })
        if (!res.ok) {
          setChatStatus('error')
          const json = await res.json().catch(() => ({}))
          const msg = json?.error ?? (res.status === 401 ? 'Please log in' : res.status === 404 ? 'Chat not found' : 'Could not load result')
          setErrorMsg(msg)
          return
        }
        const json = await res.json()
        const { status, text, attachments, progress: latestProgress } = json.data ?? json
        if (latestProgress) setProgress(latestProgress)
        if (status === 'cancelled') { clearPending(); setChatStatus('idle'); setProgress(null); return }

        if (status === 'completed') {
          const newId = genId()
          setMessages(prev => [...prev, { id: newId, role: 'assistant', content: text ?? '', attachments: attachments ?? [] }])
          startTypewriter(newId, text ?? '')
          clearPending()
          setChatStatus('idle')
          setErrorMsg('')
          return
        }

        if (status === 'failed') {
          setChatStatus('error')
          setErrorMsg('The agent did not respond in time. You can try again or file an appeal.')
          return
        }
      } catch (e) {
        if (signal.aborted) return
        // transient network error, keep polling
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL))
    }

    setChatStatus('error')
    setErrorMsg("The agent hasn't replied yet. Come back later to check, or file an appeal if it's been a while.")
  }

  /** x402 / API errors → UI */
  async function handlePaymentError(res: Response, phase: string): Promise<boolean> {
    if (res.status === 402) {
      let raw402 = ''
      try { raw402 = await res.clone().text() } catch { /* consumed */ }
      console.error(`[x402/chat] 402 [${phase}]:`, raw402 || '(empty)')
      setChatStatus('error')
      if (!walletReady) {
        console.warn('[x402/chat] walletReady=false → CDP session expired, need re-login')
        setErrorMsg('payment_required')
      } else {
        const hint = raw402 ? raw402.slice(0, 300) : `Payment signing failed (insufficient balance?)`
        setRawX402Error(`[${phase}] ${hint}`)
        setErrorMsg('Payment could not be completed. Check your wallet or try again; a payment challenge does not necessarily mean insufficient balance.')
      }
      return true
    }
    if (!res.ok && res.status !== 202 && res.status !== 200) {
      const json = await res.json().catch(() => ({}))
      const code: string = json.code ?? ''
      const detail: string = json.error ?? ''
      if (code === 'acceptance_not_allowed' || detail.includes('acceptance_not_allowed')) {
        setErrorMsg('Paid chat is unavailable for this account or Agent during the payment trial.')
      } else if (res.status === 503) {
        if (code === 'agent_offline') setErrorMsg(`Agent offline: ${detail}`)
        else if (code === 'agent_busy') setErrorMsg('Agent is busy (at max concurrent chats). Try later.')
        else if (code === 'no_wallet') setErrorMsg('Agent has no payout wallet configured.')
        else setErrorMsg(detail || 'Agent unavailable. Try later.')
      } else if (res.status === 500 && code === 'payment_failed') {
        setErrorMsg(`[${phase}] Payment failed: ${detail}`)
      } else {
        setErrorMsg(detail || 'Something went wrong. Try again.')
      }
      setChatStatus('error')
      return true
    }
    return false
  }

  // Send message
  async function handleSubmit(message: { text: string; attachments?: import('@/lib/attachment-policy').ChatAttachment[] }) {
    const text = message.text.trim()
    if ((!text && !message.attachments?.length) || !agent?.online || chatStatus !== 'idle' || sendingRef.current) return
    if (pendingMessageRef.current) {
      setErrorMsg('Retry the saved message first. Its payment request must not be replaced.')
      setChatStatus('error')
      return
    }

    pollAbortRef.current?.abort()

    const userMsg: StoredMessage = { id: genId(), role: 'user', content: text, attachments: message.attachments }
    navigationRef.current++
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setChatStatus('sending')
    setErrorMsg('')
    setRawX402Error('')

    const pending: PendingMessage = { key: crypto.randomUUID(), chatId, messages: newMessages, quotes: {} }
    pendingMessageRef.current = pending
    await sendPendingMessage(pending)
  }

  async function sendPendingMessage(pending: PendingMessage) {
    if (sendingRef.current) return
    sendingRef.current = true
    setChatStatus('sending')
    setErrorMsg('')
    setRawX402Error('')
    try {
      persistPending(pending)
      if (pending.accepted) {
        setChatStatus('waiting')
        const ac = new AbortController()
        pollAbortRef.current = ac
        await pollResult(pending.accepted.chatId, pending.accepted.taskId, ac.signal)
        return
      }
      const requestOptions = (phase: PaymentPhase): RequestInit => ({
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-agent-wallet': walletAddress, 'Idempotency-Key': pending.key },
        body: JSON.stringify({ chat_id: pending.chatId, messages: pending.messages.map(m => ({ role: m.role, content: m.content, ...(m.attachments?.length ? { attachments: m.attachments } : {}) })), payment_target: phase }),
      })
      const res = await submitChatPayment({
        quotes: pending.quotes,
        request: phase => fetch('/api/chat', requestOptions(phase)),
        confirm: async (phase, quote) => {
          persistPending(pending)
          if (!walletReady || !agent) throw new Error('Payment required: sign in to your wallet first')
          const response = await fetch('/api/chat/eligibility?' + new URLSearchParams({ agent_id: agent.id, chat_id: pending.chatId, idempotency_key: pending.key }), { cache: 'no-store' })
          if (!response.ok) throw new Error('Could not verify current payment eligibility')
          const current: ChatEligibility = await response.json()
          if (current.paymentEnabled !== true) throw new Error('Paid messages are unavailable or require payment review')
          const scope = paymentScope(agent.id, payerRef.current, current)
          const balanceRes = await fetch('/api/wallet/balance', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
          const balanceData = (await balanceRes.json()).data
          if (!balanceRes.ok) throw new Error('Could not verify your payment wallet balance. Please retry shortly.')
          assertPaymentBalance(balanceData, scope.payer, phase === 'platform_fee' ? scope.priceMicro : scope.agentMicro)
          if (BigInt(current.remainingBudgetMicro) < BigInt(scope.priceMicro)) throw new Error('Payment budget is insufficient for this message')
          if (!quoteMatchesScope(phase, quote, scope)) throw new Error('Payment quote changed. Retry to review the current price.')
          let grant = grantRef.current
          if (!grantMatches(grant, scope)) {
            revokePaymentGrant()
            const accepted = await new Promise<boolean>(resolve => {
              paymentDecisionRef.current = resolve
              setPaymentConfirmation({ scope, remainingBudgetMicro: String(current.remainingBudgetMicro) })
            })
            if (!accepted) return false
            if (payerRef.current.toLowerCase() !== scope.payer) throw new Error('Payment wallet changed. Authorize again.')
            grant = createPaymentGrant(scope, String(current.remainingBudgetMicro))
            grantRef.current = grant
          }
          reserveMessage(grant, pending.key, String(current.remainingBudgetMicro))
          setPaymentGrant({ ...grant, reserved: { ...grant.reserved } })
          return true
        },
        pay: async (phase, quote) => {
          pending.paymentAttempted = true
          persistPending(pending)
          approvedPaymentRef.current = { key: pending.key, phase, quote }
          try { return await fetchWithPayment('/api/chat', requestOptions(phase)) }
          finally { approvedPaymentRef.current = null }
        },
      })
      const agentError = await handlePaymentError(res, 'agent')
      if (agentError) return

      const json = await res.json()
      const taskId: string    = json.task_id ?? json.data?.task_id ?? ''
      const serverChatId: string = json.chat_id ?? json.data?.chat_id ?? pending.chatId
      const isFree: boolean   = json.is_free ?? json.data?.is_free ?? false
      const slotHint: string  = json.slot_hint ?? ''
      pending.accepted = { chatId: serverChatId, taskId }
      persistPending(pending)
      void refetchEligibility()

      setLastMsgIsFree(isFree)
      if (slotHint) setLiveSlotHint(slotHint)

      setChatStatus('waiting')

      const ac = new AbortController()
      pollAbortRef.current = ac
      await pollResult(serverChatId, taskId, ac.signal)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e ?? '')
      const msgLower = msg.toLowerCase()
      console.error('[x402/chat] error:', msg, e)
      setRawX402Error(msg)
      if (msg.includes('402') || msgLower.includes('payment required')) {
        setChatStatus('error')
        setErrorMsg('payment_required')
      } else if (msgLower.includes('insufficient usdc balance')) {
        // Only the verified USDC balance check should open funding automatically.
        setChatStatus('error')
        setErrorMsg('usdc_insufficient')
      } else if (msgLower.includes('no account found') || msgLower.includes('user not authenticated')) {
        setChatStatus('error')
        setErrorMsg('payment_required')
      } else {
        setChatStatus('error')
        setErrorMsg(msg || 'Something went wrong. Try again.')
      }
    } finally {
      sendingRef.current = false
    }
  }

  async function stopPolling() {
    const accepted = pendingMessageRef.current?.accepted
    if (!accepted || chatStatus === 'sending') return
    try {
      const response = await fetch('/api/chat/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accepted) })
      if (!response.ok) throw new Error('Could not cancel. Please try again.')
      const result = await response.json()
      if (result.status === 'cancelled') {
        pollAbortRef.current?.abort()
        clearPending(); setProgress(null); setChatStatus('idle'); setErrorMsg('')
      }
    } catch (e) { setErrorMsg(e instanceof Error ? e.message : 'Could not cancel.') }
  }

  function newChat() {
    if (sendingRef.current) return
    if (!window.matchMedia('(min-width: 768px)').matches) setSidebarOpen(false)
    navigationRef.current++
    if (pendingMessageRef.current?.paymentAttempted && !pendingMessageRef.current.accepted) {
      setErrorMsg('Retry the current message before switching chats so an existing payment can be recovered.')
      return
    }
    clearPending()
    pollAbortRef.current?.abort()
    const id = crypto.randomUUID()
    createdAtRef.current = Date.now()
    setChatId(id)
    pendingMessageRef.current = null
    setMessages([])
    setActiveHistoryId(null)
    setErrorMsg('')
    setChatStatus('idle')
  }

  function loadChat(chat: StoredChat) {
    if (sendingRef.current) return
    if (!window.matchMedia('(min-width: 768px)').matches) setSidebarOpen(false)
    if (pendingMessageRef.current?.paymentAttempted && !pendingMessageRef.current.accepted) {
      setErrorMsg('Retry the current message before switching chats so an existing payment can be recovered.')
      return
    }
    const navigation = ++navigationRef.current
    clearPending()
    pollAbortRef.current?.abort()
    createdAtRef.current = chat.createdAt
    setChatId(chat.id)
    setActiveHistoryId(chat.id)
    setErrorMsg('')
    setChatStatus('idle')

    setMessages(chat.messages)
    fetch('/api/chat/history?chatId=' + chat.id)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (navigationRef.current !== navigation || !json?.data) return
        const dbMsgs: StoredMessage[] = json.data.messages
        setMessages(dbMsgs)
        saveChat({ ...chat, messages: dbMsgs })
        const active = json.data.activeRequest
        if (active) {
          const pending: PendingMessage = { key: 'resume-' + active.id, chatId: chat.id, messages: dbMsgs, quotes: {}, accepted: { chatId: chat.id, taskId: active.id } }
          pendingMessageRef.current = pending
          persistPending(pending)
          setChatStatus('waiting')
          const ac = new AbortController()
          pollAbortRef.current = ac
          void pollResult(chat.id, active.id, ac.signal)
        }
      }).catch(() => {})
  }

  function handleDeleteChat(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    removeChat(id)
    refreshHistory()
    if (activeHistoryId === id || chatId === id) newChat()
  }

  const appealMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/appeals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentWallet: walletAddress, reason: appealReason }),
      })
      if (!res.ok) {
        const text = await res.text()
        let errMsg = 'Submit failed'
        try { if (text) { const j = JSON.parse(text); errMsg = j.error ?? errMsg } } catch (_) {}
        throw new Error(errMsg)
      }
    },
    onSuccess: () => {
      setAppealOpen(false)
      setAppealReason('')
      setAppealMsg('Appeal submitted. Our team will review it.')
      setTimeout(() => setAppealMsg(''), 5000)
      qc.invalidateQueries({ queryKey: ['my-appeals'] })
    },
    onError: (e: Error) => {
      setAppealMsg(e.message ?? 'Submit failed')
    },
  })

  const grouped = groupByDate(history.filter(chat => chat.title.toLowerCase().includes(historySearch.toLowerCase())))

  // ── guard ──────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg font-medium mb-2">Please log in</p>
          <a href="/login" className="text-primary hover:underline text-sm">Log in →</a>
        </div>
      </div>
    )
  }

  const isBusy = chatStatus === 'sending' || chatStatus === 'waiting'

  return (
    <ChatRuntime key={chatId} chatId={chatId} agentWallet={walletAddress} messages={messages} busy={isBusy} disabled={!agent?.online || chatStatus === 'error' || !!pendingMessageRef.current && !isBusy}
      typingId={typingMsgId} typingText={typingText} onSend={handleSubmit}>
    <div className="flex h-dvh flex-col bg-white text-[#0d0d0d] dark:bg-black dark:text-[#ececec]">
      <header className="z-40 flex min-h-12 shrink-0 flex-wrap items-center gap-2 bg-[#fafafa] px-3 py-2 dark:bg-[#171717] sm:flex-nowrap sm:px-4">
        <a href="/" className="shrink-0 text-sm font-semibold">AgentJob</a>
        <span className="text-neutral-400">/</span>
        <Popover.Root>
          <Popover.Trigger aria-label="Agent and payment details" className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-2 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/10 sm:flex-none">
            <span className="max-w-28 truncate sm:max-w-56">{agent?.name ?? 'Loading Agent...'}</span><ChevronDown className="size-4 shrink-0 text-neutral-500" />
          </Popover.Trigger>
          <Popover.Portal><Popover.Positioner align="start" sideOffset={12} collisionPadding={12} className="z-50"><Popover.Popup className="max-h-[70dvh] w-[min(24rem,calc(100vw-24px))] overflow-y-auto rounded-2xl border bg-background p-4 text-foreground shadow-lg">
            <div className="flex items-center gap-2 text-sm font-medium"><span className={cn('size-2 rounded-full', agent?.online ? 'bg-emerald-500' : 'bg-neutral-400')} />{agent?.online ? 'Online' : 'Offline'}{agent?.hasReputationNft && <CheckCircle2 className="size-4" />}{agent?.maxConcurrentChats === 1 && <span className="ml-auto text-xs">1:1 only</span>}</div>
            <p className="mt-3 text-sm">{priceLabel} USDC per message</p>
            <p className="mt-1 text-xs text-muted-foreground">{freeEligible ? freeMessageLabel : eligibilityKnown ? 'Free messages are not available for this request.' : unknownEligibilityMessage}</p>
            {(agent?.slotHint || liveSlotHint) && <p className="mt-2 text-xs text-amber-600">{agent?.slotHint ?? liveSlotHint}</p>}
            {!!agent?.dailyReplyLimit && <p className="mt-2 text-xs text-muted-foreground">Daily reply limit: {agent.dailyReplyLimit}</p>}
            {messages.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{messages.filter(m => m.role === 'user').length} user messages{lastMsgIsFree ? ' / last message free' : ''}</p>}
            <div className="mt-4 border-t pt-3 text-xs">
              <p className="break-all font-mono">{session.wallet ?? 'Wallet initializing...'}</p>
              <p className="mt-1">{balanceLabel}</p>
              {balanceError && <button type="button" onClick={() => void refreshBalance()} disabled={balanceFetching} className="mt-1 underline disabled:opacity-50">Refresh balance</button>}
              <p className="mt-1 text-muted-foreground">{walletReady ? 'Wallet ready for authorized payments.' : 'Sign in to your wallet to authorize paid messages.'}</p>
            </div>
            {messages.length > 0 && <button type="button" onClick={() => { setAppealOpen(true); setAppealReason(''); setAppealMsg('') }} className="mt-3 flex items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-secondary"><FileQuestion className="size-4" />File an appeal</button>}
        {paymentGrant && (
          <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs">
            <span>Automatic payments authorized until {new Date(paymentGrant.expiresAt).toLocaleTimeString()}. Available: {(Number(BigInt(paymentGrant.budgetMicro) - Object.values(paymentGrant.reserved).reduce((sum, amount) => sum + BigInt(amount), BigInt(0))) / 1_000_000).toFixed(6)} USDC.</span>
            <button type="button" className="shrink-0 text-primary underline" onClick={revokePaymentGrant}>Revoke authorization</button>
          </div>
        )}


        {savedRequests.some(pending => !hiddenSavedKeys.includes(pending.key)) && (
          <details className="px-3 py-2 text-xs text-muted-foreground border-t border-border/40">
            <summary className="cursor-pointer">Saved requests ({savedRequests.filter(pending => !hiddenSavedKeys.includes(pending.key)).length})</summary>
            <p className="mt-2">Restore to retry the original payment request. Ignore only hides the entry for now; it does not change the conversation or payment.</p>
            {savedRequests.filter(pending => !hiddenSavedKeys.includes(pending.key)).map(pending => (
              <div key={pending.key} className="mt-3 space-y-1">
                <p className="truncate">{pending.messages.at(-1)?.content}</p>
                <div className="flex gap-3">
                  <button type="button" disabled={isBusy || !!pendingMessageRef.current} onClick={() => restoreRequest(pending)} className="text-primary underline disabled:opacity-40">Restore</button>
                  <button type="button" onClick={() => ignoreSavedRequest(pending.key)} className="underline">Ignore</button>
                </div>
              </div>
            ))}
          </details>
        )}

            <div className="mt-3 flex flex-wrap gap-3 border-t pt-3 text-xs">
              <a href="/agents" className="hover:underline">Agents</a>
              <a href="/api-docs" className="hover:underline">API docs</a>
              <a href="/dashboard" className="hover:underline">Dashboard</a>
              {session.role === 'admin' && <a href="/admin" className="hover:underline">Admin</a>}
              <button type="button" className="ml-auto hover:underline" onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' })
                window.location.href = '/'
              }}>Log out</button>
            </div>
          </Popover.Popup></Popover.Positioner></Popover.Portal>
        </Popover.Root>
        <span className={cn('shrink-0 text-xs', freeEligible ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} aria-label="Message price">{messageCostLabel}</span>
        <div className="ml-auto flex w-full shrink-0 items-center justify-end gap-2 text-xs sm:w-auto">
          <button type="button" onClick={() => void refreshBalance()} disabled={balanceFetching || !session.wallet} title="Refresh wallet balance" className="hidden font-mono text-muted-foreground hover:underline disabled:no-underline lg:inline">{session.wallet ? session.wallet.slice(0,6) + '...' + session.wallet.slice(-4) : 'Wallet...'} / {balanceLabel}</button>
          <button type="button" onClick={() => setDepositOpen(true)} className="rounded-lg px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10">Add USDC</button>
          <a href="/api-docs" className="hidden rounded-lg px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10 xl:inline">API docs</a>
          <a href="/agents" className="hidden rounded-lg px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10 sm:inline">Agents</a>
          <a href="/dashboard" aria-label="Dashboard" title="Dashboard" className="rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/10"><LayoutDashboard className="size-4" /></a>
          <button type="button" onClick={toggleTheme} aria-label={dark ? 'Light mode' : 'Dark mode'} className="rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/10">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
        </div>
      </header>
        {!errorNoticeHidden && ((errorMsg && errorMsg !== 'payment_required' && errorMsg !== 'usdc_insufficient') || (chatStatus === 'error' && pendingMessageRef.current)) && (
          <div className="px-4 py-2.5 bg-destructive/10 border-t border-destructive/20 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm shrink-0">
            {errorMsg && errorMsg !== 'payment_required' && errorMsg !== 'usdc_insufficient' && (
              <div className="flex flex-1 min-w-[min(100%,16rem)] items-start gap-2 text-destructive">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-4 text-xs">
              <button type="button" className="text-primary underline" title="Add Base USDC. Funding does not remove payment trial restrictions." onClick={() => setDepositOpen(true)}>Please add USDC</button>
              {chatStatus === 'error' && pendingMessageRef.current && (
                <button type="button" className="text-primary underline" title="Retry this message using the same payment request" onClick={() => {
                  if (pendingMessageRef.current) void sendPendingMessage(pendingMessageRef.current)
                }}>Retry (same payment)</button>
              )}
              <button type="button" className="text-muted-foreground underline" title="Hide this notice without changing the conversation or payment request." onClick={() => setErrorNoticeHidden(true)}>Ignore</button>
            </div>
          </div>
        )}

        {appealMsg && appealMsg.startsWith('Appeal submitted') && (
          <div className="px-4 py-2 bg-emerald-500/10 border-t border-emerald-500/20 flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 shrink-0">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {appealMsg}
          </div>
        )}



              <Dialog open={appealOpen} onOpenChange={(v) => { setAppealOpen(v); if (!v) setAppealMsg('') }}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Submit appeal</DialogTitle>
                    <p className="text-xs text-muted-foreground">
                      If you paid and the agent did not respond, describe what happened here.
                    </p>
                  </DialogHeader>
                  <label className="block text-xs text-muted-foreground mb-1">Reason</label>
                  <textarea
                    value={appealReason}
                    onChange={(e) => setAppealReason(e.target.value)}
                    placeholder="e.g. Payment went through but no reply after 10+ minutes..."
                    rows={4}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                  />
                  {appealMsg && (
                    <p className={cn(
                      'text-xs px-3 py-2 rounded-xl',
                      appealMsg.startsWith('Submit failed') ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-500'
                    )}>
                      {appealMsg}
                    </p>
                  )}
                  <DialogFooter className="border-t pt-4 mt-0 gap-2">
                    <button
                      type="button"
                      onClick={() => setAppealOpen(false)}
                      className="flex-1 sm:flex-initial py-2 px-4 bg-secondary rounded-xl text-sm hover:bg-secondary/70"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => appealMutation.mutate()}
                      disabled={appealReason.trim().length < 10 || appealMutation.isPending}
                      className="flex-1 sm:flex-initial py-2 px-4 bg-primary hover:bg-primary/90 text-white rounded-xl text-sm disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {appealMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                      Submit
                    </button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {sidebarOpen && <button type="button" aria-label="Close history" onClick={() => setSidebarOpen(false)} className="absolute inset-0 z-20 bg-black/30 md:hidden" />}
        <aside aria-label="Chat history" className={cn('absolute inset-y-0 left-0 z-30 flex shrink-0 flex-col overflow-hidden border-r border-black/5 bg-[#f9f9f9] transition-[width] duration-200 dark:border-white/10 dark:bg-[#171717] md:static md:z-auto', sidebarOpen ? 'w-65' : 'hidden w-12 md:flex')}>
          <div className="flex h-12 shrink-0 items-center gap-2 px-2">
            <button type="button" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setSidebarOpen(v => !v)} className="flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"><PanelLeftClose className="size-4" /></button>
            {sidebarOpen && <span className="text-sm font-medium">Chats</span>}
          </div>
          <div className="px-2 pb-2">
            <button type="button" onClick={newChat} aria-label="New chat" title="New chat" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"><Plus className="size-4 shrink-0" />{sidebarOpen && <span className="whitespace-nowrap">New chat</span>}</button>
          </div>
          {sidebarOpen && <>
            <div className="relative mx-3 my-2"><Search className="absolute left-2 top-2.5 size-3.5 text-neutral-500" /><input aria-label="Search chats" value={historySearch} onChange={e => setHistorySearch(e.target.value)} placeholder="Search chats" className="w-full rounded-lg border border-black/10 bg-transparent py-2 pl-7 pr-2 text-xs outline-none focus:border-neutral-400 dark:border-white/15" /></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {grouped.length === 0 ? <p className="px-2 py-4 text-xs text-neutral-500">{historySearch ? 'No matching chats' : 'No chats yet'}</p> : grouped.map(({label,items}) => <div key={label} className="mb-4">
                <p className="px-2 pb-1 pt-3 text-xs text-neutral-500">{label}</p>
                {items.map(chat => <div key={chat.id} className={cn('group relative flex items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10', (activeHistoryId === chat.id || (!activeHistoryId && chatId === chat.id)) && 'bg-black/5 dark:bg-white/10')}>
                  <button type="button" onClick={() => loadChat(chat)} className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm" title={chat.title}>{chat.title}</button>
                  <button type="button" aria-label={'Delete chat: ' + chat.title} onClick={e => handleDeleteChat(e,chat.id)} className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-red-500 focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
                </div>)}
              </div>)}
            </div>
          </>}
        </aside>
        <ThreadPrimitive.Root className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <button type="button" aria-label="Open chat history" onClick={() => setSidebarOpen(true)} className="absolute left-2 top-2 z-10 flex size-8 items-center justify-center rounded-lg bg-white/80 dark:bg-black/80 md:hidden"><PanelLeftOpen className="size-4" /></button>
          {messages.length > 0 && <ChatMessages progress={progress} status={chatStatus} waiting={isBusy && messages.at(-1)?.role !== 'assistant'} />}

        <Dialog open={!!paymentConfirmation} onOpenChange={open => { if (!open) decidePayment(false) }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Authorize payments for this Agent</DialogTitle>
            </DialogHeader>
            <p className="text-sm">{agent?.name} / Base mainnet / USDC</p>
            <p className="text-xs text-muted-foreground">Paying wallet</p>
            <p className="break-all font-mono text-xs">{paymentConfirmation?.scope.payer}</p>
            <p className="text-lg font-semibold">{paymentConfirmation ? (Number(paymentConfirmation.scope.priceMicro) / 1_000_000).toFixed(6) : '0'} USDC per message</p>
            <p className="text-xs">Platform: {paymentConfirmation ? (Number(paymentConfirmation.scope.platformFeeMicro) / 1_000_000).toFixed(6) : '0'} USDC</p>
            <p className="break-all font-mono text-xs">{paymentConfirmation?.scope.platformRecipient}</p>
            <p className="text-xs">Agent: {paymentConfirmation ? (Number(paymentConfirmation.scope.agentMicro) / 1_000_000).toFixed(6) : '0'} USDC</p>
            <p className="break-all font-mono text-xs">{paymentConfirmation?.scope.agentRecipient}</p>
            <p className="text-sm">Remaining budget: {paymentConfirmation ? (Math.min(Number(paymentConfirmation.remainingBudgetMicro), 1_000_000) / 1_000_000).toFixed(6) : '0'} USDC</p>
            <p className="text-xs text-muted-foreground">For one hour in this tab, sending a paid message automatically signs its platform and Agent payments within this budget. Refreshing or revoking ends authorization. Changed prices, recipients or wallets require a new authorization. Failed attempts keep their budget reserved.</p>
            <DialogFooter>
              <button type="button" className="rounded-xl bg-secondary px-4 py-2 text-sm" onClick={() => decidePayment(false)}>Cancel</button>
              <button type="button" className="rounded-xl bg-primary px-4 py-2 text-sm text-white" onClick={() => decidePayment(true)}>Authorize budget</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DepositDialog open={depositOpen || errorMsg === 'usdc_insufficient'} insufficient={errorMsg === 'usdc_insufficient'} address={payer || session?.wallet} onOpenChange={open => {
          setDepositOpen(open)
          if (!open && errorMsg === 'usdc_insufficient') { setErrorMsg('Balance was insufficient. After funding, retry the saved message.'); setRawX402Error('') }
        }} />

        {errorMsg === 'payment_required' && !walletReady && (
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-10 p-4">
            <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full">
              <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center mb-4">
                <Wallet className="w-6 h-6 text-amber-500" />
              </div>
              <h2 className="text-lg font-semibold mb-2">Wallet session expired</h2>
              <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                Your payment wallet session has expired. Please log in again in a new tab, then refresh this page to continue.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setErrorMsg('')}
                  className="flex-1 py-2.5 bg-secondary rounded-xl text-sm hover:bg-secondary/70 transition-colors"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => window.open('/login', '_blank')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-xl text-sm font-medium transition-colors"
                >
                  Log in (new tab)
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        <div className={cn('px-4 sm:px-6', messages.length === 0 ? 'flex flex-1 flex-col justify-center pb-[16vh]' : 'shrink-0 pb-2 pt-2')}>
          {messages.length === 0 && <h1 className="mb-6 text-center text-2xl font-normal leading-7">Where should we begin?</h1>}
          <ChatComposer placeholder={!agent?.online ? 'Agent is currently offline' : pendingMessageRef.current && !isBusy ? `Resolve the saved request to continue · ${messageCostLabel}` : `Ask anything · ${messageCostLabel}`} disabled={isBusy || !agent?.online || chatStatus === 'error' || !!pendingMessageRef.current} status={chatStatus} onStop={stopPolling} />
          {messages.length > 0 && <p className="mt-2 text-center text-xs text-[#5d5d5d] dark:text-[#afafaf]">Agents can make mistakes. Check important info.</p>}
        </div>

      </ThreadPrimitive.Root>
      </div>
    </div>
    </ChatRuntime>
  )
}
