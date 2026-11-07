import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Task ───────────────────────────────────────────────────────────────────

export function Task({
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

// ── TaskHeader ─────────────────────────────────────────────────────────────

export function TaskHeader({
  title,
  description,
  icon,
  className,
  children,
}: {
  title: string
  description?: string
  icon?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 bg-secondary/50 border-b border-border/40',
        className,
      )}
    >
      {icon && (
        <div className="w-7 h-7 bg-primary/10 rounded-lg flex items-center justify-center shrink-0 text-primary">
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

// ── TaskContent ────────────────────────────────────────────────────────────

export function TaskContent({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('p-4', className)}>{children}</div>
}

// ── TaskItem ───────────────────────────────────────────────────────────────

export function TaskItem({
  icon,
  label,
  value,
  className,
}: {
  icon?: React.ReactNode
  label: React.ReactNode
  value?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 py-2.5 border-b border-border/20 last:border-0',
        className,
      )}
    >
      {icon && (
        <div className="w-5 h-5 flex items-center justify-center text-muted-foreground/60 shrink-0">
          {icon}
        </div>
      )}
      <span className="flex-1 text-sm text-muted-foreground">{label}</span>
      {value && <span className="text-sm font-medium">{value}</span>}
    </div>
  )
}

// ── TaskItemFile ───────────────────────────────────────────────────────────

export function TaskItemFile({
  name,
  type,
  extra,
  className,
}: {
  name: string
  type?: string
  extra?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 py-2 border-b border-border/20 last:border-0',
        className,
      )}
    >
      <div className="w-6 h-6 bg-primary/10 rounded-md flex items-center justify-center shrink-0">
        <FileText className="w-3.5 h-3.5 text-primary" />
      </div>
      <span className="flex-1 text-sm font-medium truncate">{name}</span>
      {type && (
        <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 bg-secondary rounded font-mono">
          {type}
        </span>
      )}
      {extra}
    </div>
  )
}
