'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Bot, CheckCircle2, ArrowLeft, MessageSquare,
  TrendingUp, Users, Shield, Clock, Copy, Check, Star, Wallet, Twitter,
} from 'lucide-react'
import { cn, formatUsdc } from '@/lib/utils'
import { useState } from 'react'
import { VerifiedCapabilities } from '@/components/agents/verified-capabilities'

interface AgentDetail {
  id: string
  name: string
  description?: string
  bio?: string
  priceSubsequent: string
  effectiveFreeMessagesPerUser: number
  effectiveFreeDailyMax: number
  freeSlotsRemaining: number
  freeUserDailyLimit: number
  hasReputationNft: boolean
  xVerified: boolean
  xUsername?: string
  totalHired: number
  totalChats: number
  totalRevenue: string
  successRate: string
  noResponseCount: number
  maxConcurrentChats: number
  onlineStatus: 'online' | 'busy' | 'offline'
  online: boolean
  walletAddress?: string | null
  createdAt: string
  skillTags: { id: string; name: string }[]
  frameworkTags: { id: string; name: string }[]
  runtimeTags: { id: string; name: string }[]
  modelTag?: { id: string; name: string; provider?: string } | null
  agentType?: { id: string; name: string } | null
}

const STATUS_CONFIG = {
  online: { dot: 'bg-emerald-500', text: 'Online', badge: 'bg-emerald-500/10 text-emerald-500' },
  busy: { dot: 'bg-amber-500', text: 'Busy', badge: 'bg-amber-500/10 text-amber-500' },
  offline: { dot: 'bg-muted-foreground/40', text: 'Offline', badge: 'bg-muted/50 text-muted-foreground' },
}

export default function AgentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const walletAddress = params.walletAddress as string
  const [copiedWallet, setCopiedWallet] = useState(false)

  const { data: agent, isLoading } = useQuery<AgentDetail>({
    queryKey: ['agent', walletAddress],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${walletAddress}`)
      if (!res.ok) throw new Error('Not found')
      const { data } = await res.json()
      return data
    },
    refetchInterval: 10_000,
  })

  function copyWallet(addr: string) {
    navigator.clipboard.writeText(addr)
    setCopiedWallet(true)
    setTimeout(() => setCopiedWallet(false), 2000)
  }

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-card rounded-xl w-32" />
          <div className="h-48 bg-card rounded-2xl" />
          <div className="h-32 bg-card rounded-2xl" />
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <Bot className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
        <h2 className="text-xl font-semibold mb-2">Agent not found</h2>
        <Link href="/agents" className="text-primary hover:underline text-sm">← Back to marketplace</Link>
      </div>
    )
  }

  const successPct = Math.round(parseFloat(agent.successRate || '1') * 100)
  const canonicalId = agent.walletAddress ?? agent.id
  const chatHref = `/chat/${canonicalId}`
  const status = STATUS_CONFIG[agent.onlineStatus] ?? STATUS_CONFIG.offline

  const chatButton = (
            <button
              onClick={() => router.push(chatHref)}
              disabled={!agent.online}
              className={cn(
                'w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm transition-colors cursor-pointer',
                agent.onlineStatus === 'online'
                  ? 'bg-primary hover:bg-primary/90 text-white'
                  : agent.onlineStatus === 'busy'
                  ? 'bg-amber-500/10 text-amber-600 cursor-not-allowed'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
            >
              <MessageSquare className="w-4 h-4" />
              {agent.onlineStatus === 'online' ? 'Start chat'
                : agent.onlineStatus === 'busy' ? 'Busy—try later'
                : 'Offline'}
            </button>
  )

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Agents
      </Link>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left */}
        <div className="lg:col-span-2 min-w-0 space-y-4">

          {/* Profile card */}
          <div className="bg-card border border-border/40 rounded-2xl p-6">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center shrink-0">
                <Bot className="w-8 h-8 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold break-words min-w-0">{agent.name}</h1>
                  {agent.hasReputationNft && (
                    <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">
                      <CheckCircle2 className="w-3 h-3" />Rep NFT
                    </span>
                  )}
                  {agent.xVerified && (
                    <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-sky-500/10 text-sky-500 rounded-full">
                      <Twitter className="w-3 h-3" />
                      {agent.xUsername ? `@${agent.xUsername}` : 'X verified'}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className={cn('flex items-center gap-1 text-xs px-2 py-0.5 rounded-full', status.badge)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', status.dot)} />
                    {status.text}
                  </span>
                  {agent.agentType && (
                    <span className="text-xs px-2 py-0.5 bg-secondary rounded-full text-muted-foreground">
                      {agent.agentType.name}
                    </span>
                  )}
                  {agent.maxConcurrentChats === 1 && (
                    <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-amber-500/10 text-amber-500 rounded-full">
                      <Shield className="w-3 h-3" />1:1 only
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mb-4 space-y-2 lg:hidden">
              {chatButton}
              <p className="text-xs text-muted-foreground">{formatUsdc(agent.priceSubsequent)} USDC / message ? Up to {agent.effectiveFreeDailyMax > 0 ? agent.effectiveFreeMessagesPerUser : 0} free / user</p>
            </div>

            {/* Bio */}
            {agent.bio && (
              <p className="text-sm text-muted-foreground bg-secondary/50 rounded-xl px-4 py-2.5 mb-4">
                {agent.bio}
              </p>
            )}

            {/* Description */}
            {agent.description && (
              <p className="text-sm text-muted-foreground leading-relaxed break-words mb-4">{agent.description}</p>
            )}

            {/* Tags */}
            {(agent.skillTags.length > 0 || agent.modelTag || agent.frameworkTags.length > 0 || agent.runtimeTags.length > 0) && (
              <div className="space-y-3 border-t border-border/30 pt-4">
                {agent.skillTags.length > 0 && (
                  <TagRow label="Skill">
                    {agent.skillTags.map(t => (
                      <TagPill key={t.id} color="primary">{t.name}</TagPill>
                    ))}
                  </TagRow>
                )}
                {agent.modelTag && (
                  <TagRow label="Model">
                    <TagPill color="secondary">{agent.modelTag.name}</TagPill>
                    {agent.modelTag.provider && (
                      <span className="text-xs text-muted-foreground/60">{agent.modelTag.provider}</span>
                    )}
                  </TagRow>
                )}
                {agent.frameworkTags.length > 0 && (
                  <TagRow label="Framework">
                    {agent.frameworkTags.map(t => <TagPill key={t.id} color="secondary">{t.name}</TagPill>)}
                  </TagRow>
                )}
                {agent.runtimeTags.length > 0 && (
                  <TagRow label="Runtime">
                    {agent.runtimeTags.map(t => <TagPill key={t.id} color="secondary">{t.name}</TagPill>)}
                  </TagRow>
                )}
                <p className="text-xs text-muted-foreground">Provider-reported</p>
              </div>
            )}
            <VerifiedCapabilities walletAddress={walletAddress} />
          </div>

          {/* Stats */}
          <div className="bg-card border border-border/40 rounded-2xl p-6">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Reputation</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatItem icon={Users} label="Hires" value={`${agent.totalHired}`} />
              <StatItem icon={MessageSquare} label="Chats" value={`${agent.totalChats}`} />
              <StatItem
                icon={TrendingUp}
                label="Success rate"
                value={`${successPct}%`}
                valueClass={successPct >= 90 ? 'text-emerald-500' : successPct >= 70 ? 'text-amber-500' : 'text-red-400'}
              />
              <StatItem icon={Star} label="Revenue" value={`${formatUsdc(agent.totalRevenue)} U`} />
            </div>
          </div>

          {/* Wallet */}
          {agent.walletAddress && (
            <div className="bg-card border border-border/40 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Wallet className="w-3.5 h-3.5" />Wallet
                </span>
                <button onClick={() => copyWallet(agent.walletAddress!)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  {copiedWallet ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedWallet ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-xs font-mono text-muted-foreground truncate">{agent.walletAddress}</p>
            </div>
          )}
        </div>

        {/* Right: pricing & CTA */}
        <div className="space-y-4">
          <div className="bg-card border border-border/40 rounded-2xl p-6 sticky top-24">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Pricing</h2>
            <div className="space-y-3 mb-6">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Paid message</span>
                <span className="font-semibold text-primary">{formatUsdc(agent.priceSubsequent)} USDC</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Free per user</span>
                <span className="font-semibold text-emerald-500">Up to {agent.effectiveFreeDailyMax > 0 ? agent.effectiveFreeMessagesPerUser : 0}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Free slots today</span>
                <span className="text-sm font-medium">{agent.freeSlotsRemaining} / {agent.effectiveFreeDailyMax}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">Per-user allowance is shared across all chats with this Agent. Daily slots are shared by all users and reset at 00:00 UTC. Your platform limit is {agent.freeUserDailyLimit} free messages per UTC day. Availability is checked before sending.</p>
            </div>

            <div className="hidden lg:block">{chatButton}</div>

            {agent.onlineStatus === 'busy' && (
              <p className="text-xs text-amber-500/80 text-center mt-2 flex items-center justify-center gap-1">
                <Shield className="w-3 h-3" />Exclusive mode—serving another user
              </p>
            )}

            <div className="mt-4 pt-4 border-t border-border/40">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="w-3.5 h-3.5" />
                Joined {new Date(agent.createdAt).toLocaleDateString('en-US')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TagRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-muted-foreground/60 w-16 shrink-0 pt-0.5">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function TagPill({ children, color }: { children: React.ReactNode; color: 'primary' | 'secondary' }) {
  return (
    <span className={cn(
      'text-xs px-2 py-0.5 rounded-md',
      color === 'primary' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'
    )}>
      {children}
    </span>
  )
}

function StatItem({ icon: Icon, label, value, valueClass }: {
  icon: React.ElementType; label: string; value: string; valueClass?: string
}) {
  return (
    <div className="text-center p-3 bg-secondary/50 rounded-xl">
      <Icon className="w-4 h-4 text-muted-foreground mx-auto mb-1.5" />
      <p className={cn('font-semibold text-sm', valueClass)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}
