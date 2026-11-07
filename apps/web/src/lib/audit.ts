import { getDb } from '@/lib/db'
import { auditLogs } from '@agentjob/db'

export type AuditAction =
  | 'verification'
  | 'login'
  | 'logout'
  | 'ban'
  | 'unban'
  | 'config_update'
  | 'appeal_resolve'
  | 'payment'
  | 'agent_register'
  | 'tender_create'
  | 'tender_close'
  | 'task_delete'

export interface AuditOptions {
  userId?: string
  action: AuditAction
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
}

/** Append audit log (fire-and-forget). */
export function writeAuditLog(opts: AuditOptions): void {
  const db = getDb()
  db.insert(auditLogs).values({
    userId: opts.userId ?? null,
    action: opts.action,
    targetType: opts.targetType ?? null,
    targetId: opts.targetId ?? null,
    metadata: opts.metadata ?? null,
    ipAddress: opts.ipAddress ?? null,
  }).catch((e) => console.error('[audit] Failed to write log', e))
}

/** Client IP from x-forwarded-for / proxy headers. */
export function getClientIp(req: Request): string | undefined {
  const forwarded = (req.headers as Headers).get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return undefined
}
