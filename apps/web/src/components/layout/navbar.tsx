'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { LanguageMenu } from './language-menu'

import { Bot, LayoutDashboard, LogIn, LogOut, ShieldCheck, Sun, Moon, BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'

export function useDarkMode() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('theme')
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const initial = saved ? saved === 'dark' : prefersDark
    setDark(initial)
    document.documentElement.classList.toggle('dark', initial)
    const syncTheme = () => setDark(document.documentElement.classList.contains('dark'))
    window.addEventListener('agentjob-theme-change', syncTheme)
    return () => window.removeEventListener('agentjob-theme-change', syncTheme)
  }, [])

  function toggle() {
    const next = !document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
    window.dispatchEvent(new Event('agentjob-theme-change'))
  }

  return { dark, toggle }
}

interface SessionUser {
  userId: string
  email: string
  role: 'user' | 'admin'
  wallet?: string
}

function useSession() {
  return useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return null
      const { data } = await res.json()
      return data
    },
  })
}

export function Navbar() {
  const pathname = usePathname()
  const chinese = pathname === '/zh'
  const { data: session } = useSession()
  const { dark, toggle } = useDarkMode()

  const links = [
    { href: '/agents', label: chinese ? '浏览 Agent' : 'Agents', icon: Bot },

    { href: '/api-docs', label: chinese ? 'API 文档' : 'API docs', icon: BookOpen },
  ]

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/'
  }

  // Chat provides a single compact top bar for navigation and Agent controls.
  if (pathname.startsWith('/chat/')) return null

  return (
    <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <nav className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-1">
        {/* Logo */}
        <Link href={chinese ? '/zh' : '/'} className="flex items-center gap-1 sm:gap-2 font-bold text-base sm:text-lg">
          <Image
            src="/logo.png"
            alt="AgentJob"
            width={32}
            height={32}
            sizes="32px"
            className="h-6 w-6 sm:h-8 sm:w-8 shrink-0 object-contain"
            priority
          />
          <span className="text-foreground">AgentJob</span>
        </Link>

        {/* Nav links */}
        <div className="hidden md:flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                pathname.startsWith(href)
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </div>

        {/* Auth */}
        <div className="flex items-center gap-1 sm:gap-2">
          <LanguageMenu chinese={chinese} />
          {/* Dark mode toggle */}
          <button
            onClick={toggle}
            className="text-muted-foreground hover:text-foreground p-2 rounded-lg hover:bg-secondary transition-colors"
            title={chinese ? (dark ? '浅色模式' : '深色模式') : dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          {session ? (
            <>
              {session.role === 'admin' && (
                <Link
                  href="/admin"
                  className="text-muted-foreground hover:text-foreground p-2 rounded-lg hover:bg-secondary transition-colors"
                  title="Admin"
                >
                  <ShieldCheck className="w-4 h-4" />
                </Link>
              )}
              <Link
                href="/dashboard"
                className={cn(
                  'flex items-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  pathname.startsWith('/dashboard')
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                )}
              >
                <LayoutDashboard className="w-4 h-4" />
                <span className="hidden sm:inline">{chinese ? '仪表盘' : 'Dashboard'}</span>
              </Link>
              <button
                onClick={handleLogout}
                className="text-muted-foreground hover:text-foreground p-2 rounded-lg hover:bg-secondary transition-colors"
                title={chinese ? '退出登录' : 'Log out'}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          ) : (
            <Link
              href="/login"
              className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <LogIn className="w-4 h-4" />
              {chinese ? '登录' : 'Log in'}
            </Link>
          )}
        </div>
      </nav>
    </header>
  )
}

