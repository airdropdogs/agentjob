import { cn } from '@/lib/utils'

// ── Queue ──────────────────────────────────────────────────────────────────

export function Queue({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('border border-border/40 rounded-2xl overflow-hidden', className)}>
      {children}
    </div>
  )
}

// ── QueueHeader ────────────────────────────────────────────────────────────

export function QueueHeader({
  title,
  count,
  className,
  children,
}: {
  title: string
  count?: number
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-2.5',
        'bg-secondary/50 border-b border-border/40',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {count !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 bg-background border border-border/40 rounded-full text-muted-foreground leading-none">
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

// ── QueueItem ──────────────────────────────────────────────────────────────

export type QueueStatus = 'active' | 'pending' | 'done' | 'error' | 'offline'

const DOT_CLASS: Record<QueueStatus, string> = {
  active:  'bg-emerald-500',
  pending: 'bg-amber-400 animate-pulse',
  done:    'bg-muted-foreground/40',
  error:   'bg-red-400',
  offline: 'bg-muted-foreground/40',
}

export function QueueItem({
  status = 'pending',
  title,
  meta,
  extra,
  actions,
  className,
  onClick,
  href,
}: {
  status?: QueueStatus
  title: React.ReactNode
  meta?: React.ReactNode
  extra?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  onClick?: () => void
  href?: string
}) {
  const interactive = !!(href || onClick)

  const inner = (
    <>
      <span className={cn('w-2 h-2 rounded-full shrink-0 mt-0.5', DOT_CLASS[status])} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate leading-snug">{title}</div>
        {meta && <div className="text-xs text-muted-foreground mt-0.5 truncate">{meta}</div>}
      </div>
      {extra && <div className="shrink-0 text-xs text-muted-foreground">{extra}</div>}
      {actions && <div className="shrink-0 ml-3">{actions}</div>}
    </>
  )

  const base = cn(
    'flex items-start gap-3 px-4 py-3 border-b border-border/20 last:border-0',
    interactive && 'hover:bg-secondary/40 cursor-pointer transition-colors',
    className,
  )

  if (href) {
    return (
      <a href={href} className={base}>
        {inner}
      </a>
    )
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(base, 'w-full text-left')}>
        {inner}
      </button>
    )
  }

  return <div className={base}>{inner}</div>
}

// ── QueueEmpty ─────────────────────────────────────────────────────────────

export function QueueEmpty({
  icon,
  children,
}: {
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground/60 space-y-2 px-6">
      {icon && <div className="flex justify-center opacity-30">{icon}</div>}
      <div>{children}</div>
    </div>
  )
}
