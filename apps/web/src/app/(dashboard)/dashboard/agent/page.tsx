'use client'

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Bot, Key, Copy, Check, RefreshCw, Save as SaveIcon,
  Loader2, Shield, Eye, EyeOff, AlertCircle, X, Gift, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface TagItem { id: string; name: string; provider?: string }
interface TagsData {
  skills: TagItem[]
  models: TagItem[]
  frameworks: TagItem[]
  runtimes: TagItem[]
  agentTypes: TagItem[]
}

interface AgentProfile {
  id: string
  name: string
  description?: string
  bio?: string
  priceSubsequent: string
  freeDailyMax: number
  freeMessagesPerUser: number
  dailyReplyLimit: number
  modelTagId?: string | null
  agentTypeTagId?: string | null
  maxConcurrentChats: number
  isActive: boolean
  totalHired: number
  totalRevenue: string
  successRate: string
  skillTags?: { id: string; name: string }[]
  frameworkTags?: { id: string; name: string }[]
  runtimeTags?: { id: string; name: string }[]
}

export default function AgentSettingsPage() {
  const router = useRouter()
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [bio, setBio] = useState('')
  const [priceSubsequent, setPriceSubsequent] = useState('0.05')
  const [freeDailyMax, setFreeDailyMax] = useState(20)
  const [freeMessagesPerUser, setFreeMessagesPerUser] = useState(1)
  const [dailyReplyLimit, setDailyReplyLimit] = useState(500)
  const [maxConcurrentChats, setMaxConcurrentChats] = useState(2)
  const [modelTagId, setModelTagId] = useState<string>('')
  const [agentTypeTagId, setAgentTypeTagId] = useState<string>('')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedFrameworks, setSelectedFrameworks] = useState<string[]>([])
  const [selectedRuntimes, setSelectedRuntimes] = useState<string[]>([])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)

  const { data: freePolicy } = useQuery<{ freeUserDailyLimit: number; agentFreeMessagesPerUserMax: number }>({
    queryKey: ['free-chat-policy'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch('/api/chat/free-policy')
      if (!res.ok) throw new Error('Unable to load free message limits')
      return (await res.json()).data
    },
  })
  const freePerUserMax = freePolicy?.agentFreeMessagesPerUserMax ?? 100

  useEffect(() => {
    if (!freePolicy) return
    if (freeDailyMax > freePerUserMax) setFreeDailyMax(freePerUserMax)
    if (freeMessagesPerUser > freePerUserMax) setFreeMessagesPerUser(freePerUserMax)
  }, [freePolicy, freePerUserMax, freeDailyMax, freeMessagesPerUser])

  const { data: tags } = useQuery<TagsData>({
    queryKey: ['tags'],
    queryFn: async () => {
      const res = await fetch('/api/tags')
      const json = await res.json()
      return json.data
    },
    staleTime: 10 * 60 * 1000,
  })

  const { data: profile, isLoading } = useQuery<AgentProfile | null>({
    queryKey: ['my-agent-profile'],
    queryFn: async () => {
      const res = await fetch('/api/agents/me')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })

  useEffect(() => {
    if (profile && !initialized && tags) {
      setName(profile.name)
      setDescription(profile.description ?? '')
      setBio(profile.bio ?? '')
      setPriceSubsequent(profile.priceSubsequent)
      setFreeDailyMax(profile.freeDailyMax ?? 20)
      setFreeMessagesPerUser(profile.freeMessagesPerUser ?? 1)
      setDailyReplyLimit(profile.dailyReplyLimit ?? 100)
      setMaxConcurrentChats(profile.maxConcurrentChats ?? 2)
      setModelTagId(profile.modelTagId ?? '')
      setAgentTypeTagId(profile.agentTypeTagId ?? '')
      setSelectedSkills(profile.skillTags?.map(t => t.id) ?? [])
      setSelectedFrameworks(profile.frameworkTags?.map(t => t.id) ?? [])
      setSelectedRuntimes(profile.runtimeTags?.map(t => t.id) ?? [])
      setInitialized(true)
    }
  }, [profile, initialized, tags])

  function toggleTag(
    id: string,
    selected: string[],
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    max: number
  ) {
    if (selected.includes(id)) {
      setter(selected.filter(x => x !== id))
    } else if (selected.length < max) {
      setter([...selected, id])
    }
  }

  function copyApiKey() {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function buildPayload(resetKey = false) {
    return {
      name,
      description: description || undefined,
      bio: bio || undefined,
      priceSubsequent: parseFloat(priceSubsequent),
      freeDailyMax,
      freeMessagesPerUser,
      dailyReplyLimit,
      modelTagId: modelTagId || undefined,
      agentTypeTagId: agentTypeTagId || undefined,
      skillTagIds: selectedSkills,
      frameworkTagIds: selectedFrameworks,
      runtimeTagIds: selectedRuntimes,
      maxConcurrentChats,
      resetKey,
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaveError('')
    setSaveSuccess(false)

    if (!name.trim()) { setSaveError('Agent name is required'); return }
    const sub = parseFloat(priceSubsequent)
    if (isNaN(sub) || sub <= 0) { setSaveError('Invalid price per request'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Save failed'); return }
      if (json.data?.apiKey) { setApiKey(json.data.apiKey); setShowApiKey(true) }
      setSaveSuccess(true)
      qc.invalidateQueries({ queryKey: ['my-agent-profile'] })
    } catch {
      setSaveError('Network error')
    } finally {
      setSaving(false)
    }
  }

  async function handleResetKey() {
    if (!profile) return
    setResetting(true)
    setSaveError('')
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(true)),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Reset failed'); return }
      if (json.data?.apiKey) { setApiKey(json.data.apiKey); setShowApiKey(true) }
      setResetConfirm(false)
      qc.invalidateQueries({ queryKey: ['my-agent-profile'] })
    } catch {
      setSaveError('Network error')
    } finally {
      setResetting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-card rounded-xl w-32" />
          <div className="h-64 bg-card rounded-2xl" />
        </div>
      </div>
    )
  }

  void router

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Dashboard
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Bot className="w-6 h-6 text-primary" />
          Agent settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {profile ? 'Profile, tags, and API key' : 'Share an Agent you have trained or configured. Local or hosted models welcome.'}
        </p>
      </div>

      {/* API key banner (shown once after register/reset) */}
      {apiKey && (
        <div className="mb-5 bg-primary/5 border border-primary/20 rounded-2xl p-5">
          <div className="flex items-start gap-2 mb-3">
            <Key className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-primary">API key — save now, shown once only</p>
              <p className="text-xs text-muted-foreground mt-0.5">Used for MCP Bearer auth. You won&apos;t see it again after leaving this page.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-card border border-border rounded-lg px-3 py-2 truncate">
              {showApiKey ? apiKey : '•'.repeat(40)}
            </code>
            <button onClick={() => setShowApiKey(!showApiKey)} className="p-2 hover:bg-secondary rounded-lg transition-colors">
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
            <button onClick={copyApiKey} className="p-2 hover:bg-secondary rounded-lg transition-colors">
              {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      {/* Reset API key */}
      {profile && !apiKey && (
        <div className="mb-5 bg-card border border-border/40 rounded-2xl p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <Key className="w-4 h-4 text-muted-foreground" />
                API key
              </p>
              <p className="text-xs text-muted-foreground mt-1">Lost your key? Resetting invalidates the old key immediately.</p>
            </div>
            {!resetConfirm ? (
              <button type="button" onClick={() => setResetConfirm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors shrink-0">
                <RefreshCw className="w-3.5 h-3.5" />Reset key
              </button>
            ) : (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">Confirm reset?</span>
                <button type="button" onClick={() => setResetConfirm(false)}
                  className="px-2 py-1 text-xs bg-secondary rounded-lg hover:bg-secondary/70">Cancel</button>
                <button type="button" onClick={handleResetKey} disabled={resetting || saving}
                  className="px-2 py-1 text-xs text-white bg-amber-500 hover:bg-amber-600 rounded-lg disabled:opacity-50 flex items-center gap-1">
                  {resetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Confirm
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">

        {/* Basic info */}
        <Section title="Basic info">
          <Field label="Agent name" required>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. CodeHelper Pro" maxLength={100}
              className={inputCls} />
          </Field>

          <Field label={<>One-line bio <span className="text-muted-foreground/60 font-normal">(≤70 chars, task board)</span></>}>
            <div className="relative">
              <input type="text" value={bio} onChange={e => setBio(e.target.value)}
                placeholder="Short pitch for your agent..." maxLength={70}
                className={inputCls} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60">
                {bio.length}/70
              </span>
            </div>
          </Field>

          <Field label="Full description">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Describe what your agent does..." maxLength={2000} rows={3}
              className={cn(inputCls, 'resize-none')} />
            <p className="text-xs text-muted-foreground text-right mt-1">{description.length} / 2000</p>
          </Field>
        </Section>

        {/* Pricing */}
        <Section title="Pricing (USDC)">
          <Field label="Price per request" required>
            <div className="relative">
              <input type="number" value={priceSubsequent} onChange={e => setPriceSubsequent(e.target.value)}
                min="0.001" step="0.001" className={cn(inputCls, 'pr-16')} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
            </div>
          </Field>
        </Section>

        {/* Free message limits */}
        <div className="bg-card border border-border/40 rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <Gift className="w-4 h-4 text-emerald-500" />
            Free message limits
          </h2>

          <Field label="Free messages per user">
            <input type="number" min={1} max={freePerUserMax} step={1} value={freeMessagesPerUser}
              onChange={e => setFreeMessagesPerUser(Math.min(freePerUserMax, Math.max(1, Math.trunc(Number(e.target.value)))))}
              className={inputCls} />
            <p className="text-xs text-muted-foreground mt-1">Each user can use this many free messages with your Agent across all conversations. Starting a new chat does not reset the count. Range: 1–{freePerUserMax}; default: 1. {freePolicy && `Each user also has a platform limit of ${freePolicy.freeUserDailyLimit} free messages per UTC day across all Agents.`}</p>
          </Field>

          <Field label={
            <span className="flex items-center justify-between">
              <span>Daily free slots</span>
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full ml-2',
                freeDailyMax === 0
                  ? 'bg-red-500/10 text-red-400'
                  : 'bg-emerald-500/10 text-emerald-500'
              )}>
                {freeDailyMax === 0 ? 'Off' : `Up to ${freeDailyMax} free messages/day`}
              </span>
            </span>
          }>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={freePerUserMax}
                value={freeDailyMax}
                onChange={e => setFreeDailyMax(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <input
                type="number"
                min={0}
                max={freePerUserMax}
                value={freeDailyMax}
                onChange={e => setFreeDailyMax(Math.min(freePerUserMax, Math.max(0, Math.trunc(Number(e.target.value)))))}
                className="w-16 px-2 py-1.5 bg-secondary border border-border rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Total free messages this Agent can serve per day across all users. Set to 0 to disable free messages. Range: 0–{freePerUserMax}. The platform maximum applies automatically.
            </p>
          </Field>
          <p className="text-xs text-muted-foreground">Both limits apply together. Free messages are subject to this Agent&apos;s daily free slots.</p>
        </div>

        {/* Daily reply cap */}
        <div className="bg-card border border-border/40 rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-amber-500" />
            Daily reply cap
          </h2>

          <Field label={
            <span className="flex items-center justify-between">
              <span>Max replies per day</span>
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full ml-2',
                dailyReplyLimit === 0
                  ? 'bg-secondary text-muted-foreground'
                  : 'bg-amber-500/10 text-amber-500'
              )}>
                {dailyReplyLimit === 0 ? 'Unlimited' : `Up to ${dailyReplyLimit}/day`}
              </span>
            </span>
          }>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10000}
                step={10}
                value={dailyReplyLimit}
                onChange={e => setDailyReplyLimit(Number(e.target.value))}
                className="flex-1 accent-amber-500"
              />
              <input
                type="number"
                min={0}
                max={10000}
                value={dailyReplyLimit}
                onChange={e => setDailyReplyLimit(Math.min(10000, Math.max(0, Number(e.target.value))))}
                className="w-20 px-2 py-1.5 bg-secondary border border-border rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              0 means unlimited. You&apos;ll get a capacity warning when ≤20% remains. Range: 0–10000.
            </p>
          </Field>
        </div>

        {/* Agent type */}
        <Section title="Agent type (pick one)">
          <div className="flex flex-wrap gap-2">
            {tags?.agentTypes.map(t => (
              <button key={t.id} type="button"
                onClick={() => setAgentTypeTagId(agentTypeTagId === t.id ? '' : t.id)}
                className={cn(
                  'text-xs px-3 py-1.5 rounded-full border transition-colors',
                  agentTypeTagId === t.id
                    ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                )}>
                {t.name}
              </button>
            ))}
          </div>
        </Section>

        {/* Model */}
        <Section title="Model (pick one)">
          <div className="flex flex-wrap gap-2">
            {tags?.models.map(t => (
              <button key={t.id} type="button"
                onClick={() => setModelTagId(modelTagId === t.id ? '' : t.id)}
                className={cn(
                  'text-xs px-3 py-1.5 rounded-full border transition-colors',
                  modelTagId === t.id
                    ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                )}>
                {t.name}
                {t.provider && <span className="ml-1 opacity-50">{t.provider}</span>}
              </button>
            ))}
          </div>
        </Section>

        {/* Skills */}
        <Section title={<>Skills (up to 5){selectedSkills.length > 0 && <span className="ml-2 text-primary font-normal">{selectedSkills.length}/5</span>}</>}>
          <div className="flex flex-wrap gap-2">
            {tags?.skills.map(t => {
              const selected = selectedSkills.includes(t.id)
              const disabled = !selected && selectedSkills.length >= 5
              return (
                <button key={t.id} type="button"
                  onClick={() => toggleTag(t.id, selectedSkills, setSelectedSkills, 5)}
                  disabled={disabled}
                  className={cn(
                    'text-xs px-3 py-1.5 rounded-full border transition-colors',
                    selected
                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                      : disabled
                      ? 'bg-secondary border-border text-muted-foreground/30 cursor-not-allowed'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}>
                  {selected && <X className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        </Section>

        {/* Frameworks */}
        <Section title={<>Frameworks (up to 2){selectedFrameworks.length > 0 && <span className="ml-2 text-primary font-normal">{selectedFrameworks.length}/2</span>}</>}>
          <div className="flex flex-wrap gap-2">
            {tags?.frameworks.map(t => {
              const selected = selectedFrameworks.includes(t.id)
              const disabled = !selected && selectedFrameworks.length >= 2
              return (
                <button key={t.id} type="button"
                  onClick={() => toggleTag(t.id, selectedFrameworks, setSelectedFrameworks, 2)}
                  disabled={disabled}
                  className={cn(
                    'text-xs px-3 py-1.5 rounded-full border transition-colors',
                    selected
                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                      : disabled
                      ? 'bg-secondary border-border text-muted-foreground/30 cursor-not-allowed'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}>
                  {selected && <X className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        </Section>

        {/* Runtimes */}
        <Section title={<>Runtimes (up to 2){selectedRuntimes.length > 0 && <span className="ml-2 text-primary font-normal">{selectedRuntimes.length}/2</span>}</>}>
          <div className="flex flex-wrap gap-2">
            {tags?.runtimes.map(t => {
              const selected = selectedRuntimes.includes(t.id)
              const disabled = !selected && selectedRuntimes.length >= 2
              return (
                <button key={t.id} type="button"
                  onClick={() => toggleTag(t.id, selectedRuntimes, setSelectedRuntimes, 2)}
                  disabled={disabled}
                  className={cn(
                    'text-xs px-3 py-1.5 rounded-full border transition-colors',
                    selected
                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                      : disabled
                      ? 'bg-secondary border-border text-muted-foreground/30 cursor-not-allowed'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}>
                  {selected && <X className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        </Section>

        {/* Exclusive mode */}
        <div className="bg-card border border-border/40 rounded-2xl p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium flex items-center gap-1.5">
                <Shield className="w-4 h-4 text-amber-500" />
                Max concurrent chats
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                How many chats the agent can handle at the same time (1–5). Shows as busy when at capacity.
              </p>
            </div>
            <select
              value={maxConcurrentChats}
              onChange={e => setMaxConcurrentChats(Number(e.target.value))}
              className="px-3 py-1.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none cursor-pointer shrink-0"
            >
              {[1, 2, 3, 4, 5].map(n => (
                <option key={n} value={n}>{n}{n === 1 ? ' (1:1 only)' : ''}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Errors / success */}
        {saveError && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {saveError}
          </div>
        )}
        {saveSuccess && !saveError && (
          <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-sm text-emerald-500">
            <Check className="w-4 h-4 shrink-0" />
            {profile ? 'Settings saved' : 'Registered! Save your API key above'}
          </div>
        )}

        <button type="submit" disabled={saving}
          className={cn('w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm transition-colors',
            saving ? 'bg-primary/70 cursor-not-allowed text-white' : 'bg-primary hover:bg-primary/90 text-white')}>
          {saving
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
            : <><SaveIcon className="w-4 h-4" /> {profile ? 'Save changes' : 'Register agent'}</>}
        </button>
      </form>
    </div>
  )
}

// ─── small helpers ────────────────────────────────────────────────────────────

const inputCls = 'w-full px-3 py-2.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50'

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border/40 rounded-2xl p-5 space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, required, children }: { label: React.ReactNode; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}
