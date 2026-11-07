'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Settings, Wallet, Copy, Check, Bot, FileQuestion } from 'lucide-react'
import { shortWallet } from '@/lib/utils'
import { useRouter } from 'next/navigation'

interface SessionUser {
  userId: string
  email: string
  role: 'user' | 'admin'
  wallet?: string
}

interface BalanceData {
  usdc: string
  usdcRaw: string
  smartWallet: string | null
}

export default function DashboardPage() {
  const router = useRouter()
  const [walletCopied, setWalletCopied] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)

  const { data: session, isLoading: sessionLoading } = useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })

  const { data: balance, isLoading: balanceLoading } = useQuery<BalanceData | null>({
    queryKey: ['wallet-balance'],
    queryFn: async () => {
      const res = await fetch('/api/wallet/balance')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
    enabled: !!session?.wallet,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!sessionLoading && !session) {
      router.replace('/login')
    }
  }, [sessionLoading, session, router])

  if (sessionLoading || !session) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-card rounded-xl w-48" />
          <div className="h-32 bg-card rounded-2xl" />
        </div>
      </div>
    )
  }

  const usdcDisplay =
    session.wallet && balanceLoading ? '…' : balance?.usdc != null ? `${balance.usdc} USDC` : '0.00 USDC'

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link
          href="/agents"
          className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Chat with an Agent
        </Link>
      </div>

      <div className="bg-card border border-border/40 rounded-2xl p-6 mb-6">
        <h2 className="text-sm font-medium text-muted-foreground mb-4">Account</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Email</span>
            <span className="text-sm font-medium">{session.email}</span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm text-muted-foreground shrink-0">Wallet</span>
            {session.wallet ? (
              <div className="flex flex-col items-end gap-2 min-w-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1 text-sm font-mono text-right">
                  <span className="truncate max-w-[min(100%,12rem)] sm:max-w-none hidden sm:inline">{session.wallet}</span>
                  <span className="sm:hidden">{shortWallet(session.wallet)}</span>
                  <span className="text-muted-foreground font-normal">
                    ({usdcDisplay})
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(session.wallet!)
                      setWalletCopied(true)
                      setTimeout(() => setWalletCopied(false), 2000)
                    }}
                    className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
                    title="Copy address"
                  >
                    {walletCopied ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </button>
                  <Link
                    href="/dashboard/wallet"
                    className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
                    title="Wallet settings"
                  >
                    <Settings className="w-3.5 h-3.5 text-muted-foreground" />
                  </Link>
                  <button
                    type="button"
                    onClick={() => setRechargeOpen(true)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-border bg-secondary/80 hover:bg-secondary text-foreground transition-colors"
                  >
                    Add funds
                  </button>
                </div>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground/60 flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5" />
                Initializing CDP wallet...
              </span>
            )}
          </div>
          {session.role === 'admin' && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Role</span>
              <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">Admin</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DashboardCard
          href="/dashboard/wallet"
          title="Wallet"
          description="Balance, USDC transfer, export key"
          icon={<Wallet className="w-5 h-5 text-primary" />}
        />
        <DashboardCard
          href="/dashboard/agent"
          title="Agent"
          description="Profile, pricing, API key"
          icon={<Bot className="w-5 h-5 text-primary" />}
        />
        <DashboardCard
          href="/dashboard/appeals"
          title="Appeals"
          description="Paid but no reply? Open a case"
          icon={<FileQuestion className="w-5 h-5 text-muted-foreground" />}
        />
      </div>

      {rechargeOpen && session.wallet && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recharge-title"
          onClick={() => setRechargeOpen(false)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-lg max-w-md w-full p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h2 id="recharge-title" className="text-lg font-semibold">
              Add USDC
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Send USDC to your wallet ({shortWallet(session.wallet, 4, 4)}) on Base. Gas is sponsored by the platform—you
              don&apos;t need ETH.
            </p>
            <Link href="/onramp" onClick={()=>setRechargeOpen(false)} className="block rounded-xl border border-primary p-3 text-center text-sm text-primary">
              Buy USDC with Coinbase — Sandbox
            </Link>
            <p className="text-xs text-muted-foreground">Review/test mode only. No real charge or wallet funding.</p>
            <button
              type="button"
              onClick={() => setRechargeOpen(false)}
              className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DashboardCard({
  href,
  title,
  description,
  icon,
}: {
  href: string
  title: string
  description: string
  icon: ReactNode
}) {
  return (
    <Link
      href={href}
      className="group flex gap-4 rounded-2xl border border-border/40 bg-card p-5 transition-colors hover:border-primary/30 hover:bg-secondary/30"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 group-hover:bg-primary/15">
        {icon}
      </div>
      <div className="min-w-0">
        <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
      </div>
    </Link>
  )
}
