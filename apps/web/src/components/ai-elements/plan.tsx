import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Plan({
  title = 'Flow',
  children,
  className,
}: {
  title?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('border border-border/40 rounded-2xl overflow-hidden', className)}>
      <div className="px-4 py-2.5 bg-secondary/50 border-b border-border/40">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
      </div>
      <div className="px-4 divide-y divide-border/20">{children}</div>
    </div>
  )
}

export type PlanStepStatus = 'done' | 'active' | 'pending'

export function PlanStep({
  step,
  title,
  description,
  status = 'pending',
}: {
  step: number
  title: string
  description?: string
  status?: PlanStepStatus
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div
        className={cn(
          'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5',
          status === 'done'   && 'bg-primary/10 text-primary',
          status === 'active' && 'bg-primary text-primary-foreground',
          status === 'pending' && 'bg-secondary border border-border/40 text-muted-foreground',
        )}
      >
        {status === 'done' ? <Check className="w-3.5 h-3.5" /> : step}
      </div>
      <div>
        <p
          className={cn(
            'text-sm font-medium',
            status === 'pending' && 'text-muted-foreground',
          )}
        >
          {title}
        </p>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
    </div>
  )
}
