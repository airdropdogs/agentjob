'use client'
import Link from 'next/link'
import { Bot, CheckCircle2, Twitter, Users, MessageSquare, Zap } from 'lucide-react'
import { cn, formatUsdc } from '@/lib/utils'
import { CAPABILITIES } from '@/lib/verification-policy'

interface AgentCardData {
  id: string
  name: string
  bio?: string
  priceSubsequent: string
  freeDailyMax?: number
  freeMessagesPerUser?: number
  hasReputationNft: boolean
  xVerified: boolean
  totalHired: number
  totalChats: number
  responseRank?: number
  successRate: string
  onlineStatus: 'online' | 'busy' | 'offline'
  walletAddress?: string | null
  verifiedCapabilities?: string[]
  approvedRuntime?: { framework: string; model: string } | null
  modelTag?: { id: string; name: string } | null
  agentType?: { id: string; name: string } | null
}

const STATUS_CONFIG = {
  online: { dot: 'bg-emerald-500', text: 'Online', btn: 'bg-primary text-primary-foreground hover:bg-primary/90' },
  busy: { dot: 'bg-amber-500', text: 'Busy', btn: 'bg-amber-500/10 text-amber-600' },
  offline: { dot: 'bg-muted-foreground/40', text: 'Offline', btn: 'bg-secondary text-muted-foreground' },
}

export function AgentCard({ agent, locale = 'en' }: { agent: AgentCardData; locale?: 'en' | 'zh' }) {
  const zh = locale === 'zh'
  const t = (text: string) => zh ? ({ 'Online': '在线', 'Busy': '忙碌', 'Offline': '离线', 'Reply issues': '回复异常', 'Reply unverified': '回复待验证', 'Text chat': '文字聊天', 'Image understanding': '图片理解', 'Image generation': '图片生成', 'Image editing': '图片编辑', 'Unknown': '未知' } as Record<string, string>)[text] ?? text : text
  const href = `/agents/${agent.walletAddress ?? agent.id}`
  const successPct = Math.round(parseFloat(agent.successRate || '1') * 100)
  const status = STATUS_CONFIG[agent.onlineStatus] ?? STATUS_CONFIG.offline
  const offersFree = (agent.freeDailyMax ?? 0) > 0 && (agent.freeMessagesPerUser ?? 1) > 0
  const capabilities = (agent.verifiedCapabilities ?? []).filter(id => id in CAPABILITIES).slice(0, 4)

  return (
    <div className="block group relative">
      <Link href={href} aria-label={`View ${agent.name}`} title={`${agent.name} · Framework: ${agent.approvedRuntime?.framework || 'Unknown'} · Model: ${agent.approvedRuntime?.model || 'Unknown'} (declared)`} className="absolute inset-0 z-10 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" />
      <div className="bg-card border border-border/40 rounded-2xl p-5 group-hover:border-primary/40 group-hover:shadow-sm transition-all h-[320px] flex flex-col gap-3 overflow-hidden">

        {/* Avatar + name + status */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center shrink-0">
            <Bot className="w-4.5 h-4.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 min-w-0">
              <span className="font-semibold text-sm truncate">{agent.name}</span>
              {agent.xVerified && <Twitter className="w-3 h-3 text-sky-400 shrink-0" />}
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', status.dot)} />
              <span className="text-[10px] text-muted-foreground">{t(agent.responseRank === 2 ? 'Reply issues' : agent.responseRank === 1 ? 'Reply unverified' : status.text)}</span>
              {agent.agentType && (
                <>
                  <span className="text-muted-foreground/30 text-[10px]">·</span>
                  <span className="text-[10px] text-muted-foreground truncate">{agent.agentType.name}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="h-16 shrink-0 grid grid-cols-2 grid-rows-2 gap-1 overflow-hidden" aria-label="Verified capabilities">
          {capabilities.map(id => <span key={id} className="flex min-w-0 items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 text-[10px] leading-tight text-emerald-600"><CheckCircle2 aria-hidden="true" className="h-3 w-3 shrink-0" /><span className="line-clamp-2">{t(CAPABILITIES[id as keyof typeof CAPABILITIES])}</span></span>)}
          {!capabilities.length && <span className="col-span-2 text-xs text-muted-foreground">{zh ? '尚未验证' : 'Not verified yet'}</span>}
        </div>
        <div className="h-10 shrink-0 space-y-1 text-[11px] text-muted-foreground overflow-hidden" aria-label="Published runtime information">
          <p className="truncate">{zh ? '框架：' : 'Framework: '}<span className="text-foreground">{agent.approvedRuntime?.framework || t('Unknown')}</span></p>
          <p className="truncate">{zh ? '模型：' : 'Model: '}<span className="text-foreground">{agent.approvedRuntime?.model || t('Unknown')}</span></p>
        </div>

        {/* Stats */}
        <div className="mt-auto flex items-center gap-3 text-[10px] text-muted-foreground pt-2 border-t border-border/30">
          <span className="flex items-center gap-0.5"><Users className="w-3 h-3" />{agent.totalHired}</span>
          <span className="flex items-center gap-0.5"><MessageSquare className="w-3 h-3" />{agent.totalChats}</span>
          <span className={cn('flex items-center gap-0.5',
            successPct >= 90 ? 'text-emerald-500' : successPct >= 70 ? 'text-amber-500' : 'text-red-400')}>
            <Zap className="w-3 h-3" />{successPct}%
          </span>
        </div>

        {/* Price + CTA */}
        <div className="h-12 shrink-0 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-sm font-bold text-primary">{formatUsdc(agent.priceSubsequent)}</span>
            <span className="text-[10px] text-muted-foreground ml-0.5">{zh ? 'USDC/条' : 'USDC/msg'}</span>
            {offersFree && <span className="mt-1 block text-[10px] text-emerald-500">{zh ? `每人最多 ${agent.freeMessagesPerUser ?? 1} 条免费` : `Up to ${agent.freeMessagesPerUser ?? 1} free/user`}</span>}
          </div>
          <Link href={`/chat/${agent.walletAddress ?? agent.id}`} title={offersFree ? 'Free messages subject to your remaining allowance and daily availability' : 'Open chat'} className={cn('relative z-20 shrink-0 text-[11px] px-3 py-1.5 rounded-lg font-medium transition-colors', status.btn)}>
            {agent.onlineStatus === 'online' ? offersFree ? (zh ? '免费试聊' : 'Try free') : (zh ? '聊天' : 'Chat') : t(agent.onlineStatus === 'busy' ? 'Busy' : 'Offline')}
          </Link>
        </div>
      </div>
    </div>
  )
}
