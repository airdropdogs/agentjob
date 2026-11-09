'use client'

import { useState, useEffect } from 'react'
import { VerificationPanel } from '@/components/admin/verification-panel'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { ShieldCheck, Users, Settings, Search, Ban, CheckCircle, Loader2, AlertCircle, Save, RefreshCw, BarChart3, TrendingUp, MessageSquare, DollarSign, FileQuestion, ClipboardList } from 'lucide-react'
import { cn, shortWallet } from '@/lib/utils'
import { Queue, QueueHeader, QueueItem, QueueEmpty } from '@/components/ai-elements/queue'
import { Task, TaskHeader, TaskContent, TaskItem } from '@/components/ai-elements/task'

interface SessionUser {
  userId: string
  email: string
  role: string
}

interface UserAccount {
  id: string
  email: string
  wallet?: string
  role: string
  bannedAt?: string
  bannedReason?: string
  createdAt: string
}

interface PlatformConfig {
  platformFeeRate: number
  minPriceUsdc: number
  maxPriceUsdc: number
  nftMintPriceUsdc: number
  msgRateGlobalPm: number
  msgRatePerChatPm: number
  walletTransferMinUsdc: number
  walletTransferCooldownDays: number
  agentFreeMessagesPerUserMax: number
  freeUserDailyLimit: number
  freeUserLifetimeLimit: number
}

type Tab = 'accounts' | 'config' | 'stats' | 'appeals' | 'audit' | 'verification'

export default function AdminPage() {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('accounts')

  const { data: session, isLoading: sessionLoading } = useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })

  if (sessionLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-card rounded-xl w-48" />
          <div className="h-64 bg-card rounded-2xl" />
        </div>
      </div>
    )
  }

  if (!session || session.role !== 'admin') {
    return (
      <div className="max-w-xl mx-auto px-4 py-20 text-center">
        <AlertCircle className="w-16 h-16 mx-auto mb-4 text-red-400/50" />
        <h2 className="text-xl font-semibold mb-2">Access denied</h2>
        <p className="text-muted-foreground text-sm mb-4">This page is for administrators only.</p>
        <button onClick={() => router.push('/')} className="text-primary hover:underline text-sm">
          Back to home
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
          <ShieldCheck className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Admin</h1>
          <p className="text-sm text-muted-foreground">Signed in as {session.email}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-secondary p-1 rounded-xl w-fit max-w-full overflow-x-auto">
        {([
          { id: 'accounts', label: 'Accounts', icon: Users },
          { id: 'config', label: 'Config', icon: Settings },
          { id: 'verification', label: 'Verification', icon: ShieldCheck },
          { id: 'stats', label: 'Stats', icon: BarChart3 },

          { id: 'appeals', label: 'Appeals', icon: FileQuestion },
          { id: 'audit', label: 'Audit log', icon: ClipboardList },
        ] as { id: Tab; label: string; icon: React.ElementType }[]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              tab === id
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'accounts' && <AccountsPanel />}
      {tab === 'config' && <ConfigPanel />}
      {tab === 'verification' && <VerificationPanel />}
      {tab === 'stats' && <StatsPanel />}

      {tab === 'appeals' && <AppealsPanel />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  )
}

/* ─────────────────── Accounts ─────────────────── */

function AccountsPanel() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [banTarget, setBanTarget] = useState<UserAccount | null>(null)
  const [banReason, setBanReason] = useState('')

  const { data: accounts = [], isLoading, refetch } = useQuery<UserAccount[]>({
    queryKey: ['admin-accounts', search],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      const res = await fetch(`/api/admin/accounts?${params}`)
      const { data } = await res.json()
      return data ?? []
    },
  })

  const banMutation = useMutation({
    mutationFn: async ({ userId, action, reason }: { userId: string; action: 'ban' | 'unban'; reason?: string }) => {
      const res = await fetch('/api/admin/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, reason }),
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-accounts'] })
      setBanTarget(null)
      setBanReason('')
    },
  })

  return (
    <div>
      {/* Search bar */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email..."
            className="w-full pl-9 pr-4 py-2.5 bg-card border border-border/40 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          onClick={() => refetch()}
          className="p-2.5 bg-card border border-border/40 rounded-xl hover:bg-secondary transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Total accounts" value={accounts.length} />
        <StatCard label="Admins" value={accounts.filter((a) => a.role === 'admin').length} />
        <StatCard label="Banned" value={accounts.filter((a) => a.bannedAt).length} className="text-red-400" />
      </div>

      {/* Queue list */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 bg-card border border-border/40 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <Queue>
          {/* Normal accounts */}
          {accounts.filter((a) => !a.bannedAt).length > 0 && (
            <>
              <QueueHeader title="Active" count={accounts.filter((a) => !a.bannedAt).length} />
              {accounts.filter((a) => !a.bannedAt).map((account) => (
                <QueueItem
                  key={account.id}
                  status="active"
                  title={
                    <span className="flex items-center gap-2">
                      {account.email}
                      {account.role === 'admin' && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded-full">Admin</span>
                      )}
                    </span>
                  }
                  meta={
                    <span>
                      {account.wallet ? shortWallet(account.wallet) : 'No wallet'}
                      {' · '}
                      Joined {new Date(account.createdAt).toLocaleDateString('en-US')}
                    </span>
                  }
                  actions={
                    account.role !== 'admin' ? (
                      <button
                        onClick={() => setBanTarget(account)}
                        className="text-xs px-2.5 py-1 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors"
                      >
                        Ban
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </>
          )}

          {/* Banned accounts */}
          {accounts.filter((a) => a.bannedAt).length > 0 && (
            <>
              <QueueHeader title="Banned" count={accounts.filter((a) => a.bannedAt).length} />
              {accounts.filter((a) => a.bannedAt).map((account) => (
                <QueueItem
                  key={account.id}
                  status="error"
                  title={account.email}
                  meta={account.bannedReason ?? 'No reason'}
                  actions={
                    <button
                      onClick={() => banMutation.mutate({ userId: account.id, action: 'unban' })}
                      className="text-xs px-2.5 py-1 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 rounded-lg transition-colors"
                    >
                      Unban
                    </button>
                  }
                />
              ))}
            </>
          )}

          {accounts.length === 0 && (
            <QueueEmpty icon={<Users className="w-10 h-10" />}>No accounts</QueueEmpty>
          )}
        </Queue>
      )}

      {/* Ban modal */}
      {banTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md">
            <h3 className="font-semibold mb-1">Ban account</h3>
            <p className="text-sm text-muted-foreground mb-4">{banTarget.email}</p>
            <textarea
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              placeholder="Reason (optional)..."
              rows={3}
              className="w-full px-3 py-2.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none resize-none mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setBanTarget(null); setBanReason('') }}
                className="flex-1 py-2.5 bg-secondary rounded-xl text-sm hover:bg-secondary/70 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => banMutation.mutate({ userId: banTarget.id, action: 'ban', reason: banReason || undefined })}
                disabled={banMutation.isPending}
                className="flex-1 py-2.5 bg-red-500 hover:bg-red-500/90 text-white rounded-xl text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {banMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
                Confirm ban
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className="bg-card border border-border/40 rounded-xl p-4 text-center">
      <p className={cn('text-2xl font-bold', className)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

function BigStatCard({
  label, value, sub, icon: Icon, colorClass,
}: {
  label: string; value: string | number; sub?: string
  icon: React.ElementType; colorClass?: string
}) {
  return (
    <div className="bg-card border border-border/40 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', colorClass ?? 'bg-primary/10')}>
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
      <p className="text-3xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  )
}

/* ─────────────────── Config ─────────────────── */

const CONFIG_LABELS: Record<string, { label: string; desc: string; type: 'number' | 'text' }> = {
  serverWalletDailyLimit: { label: 'Email-free registrations per day', desc: 'Platform-wide UTC-day limit. Default 100; 0 blocks new registrations. Failed attempts may consume quota.', type: 'number' },
  serverWalletIpDailyLimit: { label: 'Email-free requests per IP per day', desc: 'Default 2; 0 blocks requests. Includes retries and failed attempts. Resets at 00:00 UTC (08:00 Beijing).', type: 'number' },
  attachment_output_max_files: { label: 'Images per Agent reply', desc: '0-10 images; 0 disables image outputs.', type: 'number' },
  attachment_output_daily_mb: { label: 'Daily Agent output allowance (MB)', desc: '1-10000 MB per provider, including unfinished uploads.', type: 'number' },
  attachment_video_max_files: { label: 'Videos per Agent reply', desc: '0-5 videos; 0 disables video outputs.', type: 'number' },
  attachment_video_max_mb: { label: 'Maximum video size (MB)', desc: '1-250 MB per video.', type: 'number' },
  attachment_video_max_seconds: { label: 'Maximum video duration (seconds)', desc: '1-1800 seconds; validated from MP4 metadata.', type: 'number' },
  attachment_video_retention_days: { label: 'Video retention (days)', desc: '1-30 days for new uploads, then access expires and cleanup deletes files.', type: 'number' },
  attachment_max_files: { label: 'Files per message', desc: '1-10 files. Applied before requesting payment.', type: 'number' },
  attachment_max_mb: { label: 'Maximum file size (MB)', desc: '1-25 MB per file.', type: 'number' },
  attachment_daily_mb: { label: 'Daily upload allowance (MB)', desc: '1-1000 MB per user. Includes unfinished uploads.', type: 'number' },
  attachment_retention_days: { label: 'File access retention (days)', desc: '1-30 days for new uploads. Bucket lifecycle separately deletes stored files.', type: 'number' },
  freeUserDailyLimit: { label: 'Daily free messages per user', desc: 'Across all Agents, 0–10000 messages. Set 0 to disable free messages. Resets at 00:00 UTC.', type: 'number' },
  agentFreeMessagesPerUserMax: { label: 'Maximum Agent free allowance', desc: '1–100 messages. Caps both per-user allowances and daily free slots, including existing Agents.', type: 'number' },
  platformFeeRate: { label: 'Platform fee rate', desc: '0 = no platform fee; 0.05 = 5%. Must be less than 1. Agents receive the full listed price at 0.', type: 'number' },
  minPriceUsdc: { label: 'Minimum message price (USDC)', desc: 'Minimum price an Agent can set per message', type: 'number' },
  maxPriceUsdc: { label: 'Maximum message price (USDC)', desc: 'Maximum price an Agent can set per message', type: 'number' },
  msgRateGlobalPm: { label: 'Global messages per minute', desc: 'Maximum platform messages per minute', type: 'number' },
  msgRatePerChatPm: { label: 'Messages per chat per minute', desc: 'Maximum messages per conversation per minute', type: 'number' },
  walletTransferMinUsdc: { label: 'Minimum USDC withdrawal', desc: 'Minimum amount for sponsored withdrawals (default: 1)', type: 'number' },
  walletTransferCooldownDays: { label: 'USDC withdrawal cooldown (days)', desc: 'Minimum days between sponsored withdrawals (default: 7)', type: 'number' },
}

function ConfigPanel() {
  const qc = useQueryClient()
  const quota = useQuery<{ used: number; limit: number; remaining: number; date: string }>({
    queryKey: ['admin-registration-quota'],
    queryFn: async () => {
      const res = await fetch('/api/register/auto/quota')
      if (!res.ok) throw new Error('Registration usage unavailable')
      return (await res.json()).data
    },
    refetchInterval: 60000,
  })
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  const { data: config, isLoading } = useQuery<PlatformConfig>({
    queryKey: ['admin-config'],
    queryFn: async () => {
      const res = await fetch('/api/admin/config')
      const { data } = await res.json()
      return data
    },
  })

  useEffect(() => {
    if (config) {
      setEditValues(config as unknown as Record<string, string>)
    }
  }, [config])

  async function handleSave() {
    setSaving(true)
    setSaveMsg('')
    try {
      // camelCase keys → snake_case, values → string (API expects)
      const payload: Record<string, string> = {}
      for (const [key, value] of Object.entries(editValues)) {
        if (key === 'freeUserLifetimeLimit') continue
        const snakeKey = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
        payload[snakeKey] = String(value)
      }
      const res = await fetch('/api/admin/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setSaveMsg(`Error: ${error}`)
      } else {
        setSaveMsg('Settings saved')
        qc.invalidateQueries({ queryKey: ['admin-config'] })
        qc.invalidateQueries({ queryKey: ['admin-registration-quota'] })
      }
    } catch {
      setSaveMsg('Network error')
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(6)].map((_, i) => <div key={i} className="h-20 bg-card border border-border/40 rounded-2xl animate-pulse" />)}
      </div>
    )
  }

  return (
    <div>
      <Task className="mb-6">
        <TaskHeader title="Platform config" description="Adjust values and click Save" icon={<Settings className="w-3.5 h-3.5" />} />
        <TaskContent className="py-0">
          <label className="flex items-center gap-3 py-3 text-sm">
            <input type="checkbox" checked={String(editValues.serverWalletEnabled) === 'true'} onChange={e => setEditValues({ ...editValues, serverWalletEnabled: String(e.target.checked) })} />
            Enable email-free registration
          </label>
          <p className="pb-3 text-xs text-muted-foreground" role="status">
            {quota.data ? `Email-free registrations today (${quota.data.date} UTC): ${quota.data.used} used / ${quota.data.limit} limit / ${quota.data.remaining} remaining. Saving limits does not reset usage.` : quota.isError ? 'Registration usage unavailable.' : 'Loading registration usage...'}
          </p>
          <p className="py-3 text-xs text-muted-foreground">Free requests must satisfy the platform daily limit, the Agent per-user allowance and the Agent daily total. Lifetime free limits are disabled; historical usage is retained.</p>
          {Object.entries(CONFIG_LABELS).map(([key, meta]) => (
            <div key={key} className="flex items-center gap-4 py-3 border-b border-border/20 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{meta.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{meta.desc}</p>
              </div>
              <input
                type={meta.type}
                aria-label={meta.label}
                min={key === 'freeUserDailyLimit' ? 0 : key === 'agentFreeMessagesPerUserMax' ? 1 : undefined}
                max={key === 'freeUserDailyLimit' ? 10000 : key === 'agentFreeMessagesPerUserMax' ? 100 : undefined}
                step={key === 'freeUserDailyLimit' || key === 'agentFreeMessagesPerUserMax' ? 1 : 'any'}
                value={editValues[key] ?? ''}
                onChange={(e) => setEditValues({ ...editValues, [key]: e.target.value })}
                className="w-28 px-3 py-1.5 bg-secondary border border-border rounded-xl text-sm text-right focus:outline-none focus:ring-2 focus:ring-primary/50 shrink-0"
              />
            </div>
          ))}
        </TaskContent>
      </Task>

      {saveMsg && (
        <div className={cn(
          'mb-4 px-4 py-3 rounded-xl text-sm',
          saveMsg.startsWith('Error')
            ? 'bg-red-500/10 text-red-400'
            : 'bg-emerald-500/10 text-emerald-500'
        )}>
          {saveMsg}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-6 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save settings
      </button>
    </div>
  )
}

/* ─────────────────── Stats ─────────────────── */

interface AdminStats {
  users: { total: number; newLast7Days: number }
  agents: { active: number }
  chats: { total: number; completed: number; active: number }
  revenue: { platformTotal: string }
  appeals: { pending: number }
  recentPayments: Array<{
    id: string; amountPlatform: string; amountAgent: string
    status: string; createdAt: string
  }>
}

function StatsPanel() {
  const { data: stats, isLoading, refetch } = useQuery<AdminStats>({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/stats')
      const { data } = await res.json()
      return data
    },
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-28 bg-card border border-border/40 rounded-2xl animate-pulse" />
        ))}
      </div>
    )
  }

  if (!stats) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Overview</h2>
        <button onClick={() => refetch()} className="p-2 bg-card border border-border/40 rounded-xl hover:bg-secondary transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigStatCard
          label="Registered users"
          value={stats.users.total}
          sub={`Last 7 days +${stats.users.newLast7Days}`}
          icon={Users}
          colorClass="bg-blue-500/10"
        />
        <BigStatCard
          label="Active agents"
          value={stats.agents.active}
          icon={TrendingUp}
          colorClass="bg-emerald-500/10"
        />
        <BigStatCard
          label="Platform revenue (USDC)"
          value={stats.revenue.platformTotal}
          sub="5% platform fee (cumulative)"
          icon={DollarSign}
          colorClass="bg-amber-500/10"
        />
        <BigStatCard
          label="Pending appeals"
          value={stats.appeals.pending}
          icon={FileQuestion}
          colorClass={stats.appeals.pending > 0 ? 'bg-red-500/10' : 'bg-secondary'}
        />
      </div>

      <div className="bg-card border border-border/40 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Chats</h3>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total chats" value={stats.chats.total} />
          <StatCard label="Completed" value={stats.chats.completed} className="text-emerald-500" />
          <StatCard label="Active" value={stats.chats.active} className="text-blue-400" />
        </div>
      </div>



      {stats.recentPayments.length > 0 && (
        <div className="bg-card border border-border/40 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Recent payments</h3>
          </div>
          <div className="space-y-2">
            {stats.recentPayments.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 border-b border-border/20 last:border-0 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs">
                    {new Date(p.createdAt).toLocaleString('en-US')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    Platform {Number(p.amountPlatform).toFixed(4)} · Agent {Number(p.amountAgent).toFixed(4)} USDC
                  </span>
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full',
                    p.status === 'success'
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : 'bg-red-500/10 text-red-400'
                  )}>
                    {p.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────── Appeals ─────────────────── */

interface AppealItem {
  id: string
  chatId: string
  userId: string
  agentId: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  adminNote: string | null
  createdAt: string
  userEmail: string
  agentName: string
}

function AppealsPanel() {
  const qc = useQueryClient()
  const [resolveTarget, setResolveTarget] = useState<AppealItem | null>(null)
  const [adminNote, setAdminNote] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'resolved'>('pending')

  const { data: allAppeals = [], isLoading, refetch } = useQuery<AppealItem[]>({
    queryKey: ['admin-appeals'],
    queryFn: async () => {
      const res = await fetch('/api/admin/appeals')
      const { data } = await res.json()
      return data ?? []
    },
  })

  const resolveMutation = useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: 'approved' | 'rejected'; note?: string }) => {
      const res = await fetch(`/api/admin/appeals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, adminNote: note }),
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-appeals'] })
      setResolveTarget(null)
      setAdminNote('')
    },
  })

  const filtered = allAppeals.filter((a) => {
    if (filter === 'pending') return a.status === 'pending'
    if (filter === 'resolved') return a.status !== 'pending'
    return true
  })

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {(['pending', 'resolved', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm transition-colors',
              filter === f ? 'bg-primary text-white' : 'bg-card border border-border/40 text-muted-foreground hover:text-foreground'
            )}
          >
            {f === 'pending' ? 'Pending' : f === 'resolved' ? 'Resolved' : 'All'}
          </button>
        ))}
        <button onClick={() => refetch()} className="ml-auto p-2 bg-card border border-border/40 rounded-xl hover:bg-secondary">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-20 bg-card rounded-2xl animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">No appeals</div>
      ) : (
        <Queue>
          {filtered.map((a) => (
            <QueueItem
              key={a.id}
              status={a.status === 'pending' ? 'pending' : a.status === 'approved' ? 'active' : 'error'}
              title={
                <span className="flex items-center gap-2">
                  <span className="font-medium">{a.userEmail}</span>
                  <span className="text-xs text-muted-foreground">→ {a.agentName}</span>
                </span>
              }
              meta={<span className="line-clamp-1 text-xs">{a.reason}</span>}
              actions={
                a.status === 'pending' ? (
                  <button
                    onClick={() => setResolveTarget(a)}
                    className="text-xs px-2.5 py-1 bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors"
                  >
                    Review
                  </button>
                ) : (
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full',
                    a.status === 'approved' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-400'
                  )}>
                    {a.status === 'approved' ? 'Approved' : 'Rejected'}
                  </span>
                )
              }
            />
          ))}
        </Queue>
      )}

      {resolveTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md">
            <h3 className="font-semibold mb-1">Resolve appeal</h3>
            <p className="text-sm text-muted-foreground mb-1">{resolveTarget.userEmail}</p>
            <p className="text-xs bg-secondary rounded-xl p-3 mb-4 line-clamp-4">{resolveTarget.reason}</p>
            <textarea
              value={adminNote}
              onChange={(e) => setAdminNote(e.target.value)}
              placeholder="Admin note (optional)..."
              rows={2}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none resize-none mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setResolveTarget(null); setAdminNote('') }}
                className="flex-1 py-2.5 bg-secondary rounded-xl text-sm hover:bg-secondary/70"
              >
                Cancel
              </button>
              <button
                onClick={() => resolveMutation.mutate({ id: resolveTarget.id, status: 'rejected', note: adminNote || undefined })}
                disabled={resolveMutation.isPending}
                className="flex-1 py-2.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-sm"
              >
                Reject
              </button>
              <button
                onClick={() => resolveMutation.mutate({ id: resolveTarget.id, status: 'approved', note: adminNote || undefined })}
                disabled={resolveMutation.isPending}
                className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-500/90 text-white rounded-xl text-sm"
              >
                {resolveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────── Tasks ─────────────────── */





/* ─────────────────── Audit Logs ─────────────────── */

interface AuditLogItem {
  id: string
  userId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: string
  operatorEmail: string
}

const ACTION_LABELS: Record<string, string> = {
  login: 'Login',
  logout: 'Logout',
  ban: 'Ban user',
  unban: 'Unban user',
  config_update: 'Config update',
  appeal_resolve: 'Appeal resolved',
  payment: 'Payment',
  agent_register: 'Agent register',
  tender_create: 'Create tender',
  tender_close: 'Close tender',
  task_delete: 'Delete post',
}

function AuditPanel() {
  const [page, setPage] = useState(1)

  const { data, isLoading, refetch } = useQuery<{ logs: AuditLogItem[]; page: number; limit: number }>({
    queryKey: ['admin-audit-logs', page],
    queryFn: async () => {
      const res = await fetch(`/api/admin/audit-logs?page=${page}&limit=50`)
      const { data } = await res.json()
      return data
    },
  })

  const logs = data?.logs ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">Page {page}, 50 per page</p>
        <button onClick={() => refetch()} className="p-2 bg-card border border-border/40 rounded-xl hover:bg-secondary">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-1">{[...Array(10)].map((_, i) => <div key={i} className="h-10 bg-card rounded-xl animate-pulse" />)}</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">No logs</div>
      ) : (
        <div className="bg-card border border-border/40 rounded-2xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/40 text-muted-foreground">
                <th className="text-left px-4 py-3">Time</th>
                <th className="text-left px-4 py-3">Operator</th>
                <th className="text-left px-4 py-3">Action</th>
                <th className="text-left px-4 py-3">Target</th>
                <th className="text-left px-4 py-3">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-border/20 last:border-0 hover:bg-secondary/30 transition-colors">
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-2.5 max-w-[120px] truncate">{log.operatorEmail}</td>
                  <td className="px-4 py-2.5">
                    <span className="px-2 py-0.5 bg-primary/10 text-primary rounded-full">
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {log.targetType ? `${log.targetType}` : '-'}
                    {log.targetId ? <span className="ml-1 opacity-50">{log.targetId.slice(0, 8)}…</span> : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{log.ipAddress ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex gap-2 mt-4 justify-center">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-4 py-1.5 text-sm bg-card border border-border/40 rounded-lg disabled:opacity-40 hover:bg-secondary"
        >
          Previous
        </button>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={logs.length < 50}
          className="px-4 py-1.5 text-sm bg-card border border-border/40 rounded-lg disabled:opacity-40 hover:bg-secondary"
        >
          Next
        </button>
      </div>
    </div>
  )
}
