'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileQuestion, Loader2, AlertCircle, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Queue, QueueItem } from '@/components/ai-elements/queue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

interface Appeal {
  id: string
  chatId: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  adminNote: string | null
  createdAt: string
}

function AppealsDashboardContent() {
  const qc = useQueryClient()
  const searchParams = useSearchParams()
  const chatIdFromUrl = searchParams.get('chatId')
  const [reasonFormOpen, setReasonFormOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [submitMsg, setSubmitMsg] = useState('')

  useEffect(() => {
    if (chatIdFromUrl) setReasonFormOpen(true)
  }, [chatIdFromUrl])

  const { data: appeals = [], isLoading } = useQuery<Appeal[]>({
    queryKey: ['my-appeals'],
    queryFn: async () => {
      const res = await fetch('/api/appeals')
      if (!res.ok) return []
      const { data } = await res.json()
      return data ?? []
    },
  })

  const submitMutation = useMutation({
    mutationFn: async () => {
      const chatId = chatIdFromUrl ?? ''
      const res = await fetch('/api/appeals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, reason }),
      })
      if (!res.ok) {
        const text = await res.text()
        let errMsg = 'Submit failed'
        try {
          if (text) {
            const j = JSON.parse(text)
            errMsg = j.error ?? errMsg
          }
        } catch {
          /* ignore */
        }
        throw new Error(errMsg)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-appeals'] })
      setReasonFormOpen(false)
      setReason('')
      setSubmitMsg('Appeal submitted. Our team will review it.')
      setTimeout(() => setSubmitMsg(''), 5000)
    },
    onError: (e: Error) => {
      setSubmitMsg(`Submit failed: ${e.message}`)
    },
  })

  function statusIcon(status: Appeal['status']) {
    if (status === 'pending') return <Clock className="w-4 h-4 text-amber-500" />
    if (status === 'approved') return <CheckCircle2 className="w-4 h-4 text-emerald-500" />
    return <XCircle className="w-4 h-4 text-red-400" />
  }

  function statusLabel(status: Appeal['status']) {
    if (status === 'pending') return 'Pending'
    if (status === 'approved') return 'Approved'
    return 'Rejected'
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
          <FileQuestion className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Appeals</h1>
          <p className="text-sm text-muted-foreground">Submit from chat; view history here</p>
        </div>
      </div>

      <Dialog open={reasonFormOpen} onOpenChange={(v) => { setReasonFormOpen(v); if (!v) setSubmitMsg('') }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit appeal</DialogTitle>
            <p className="text-xs text-muted-foreground">Describe what happened. We will review.</p>
          </DialogHeader>
          <label className="block text-xs text-muted-foreground mb-1">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Paid but no reply after 10+ minutes..."
            rows={4}
            className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
          {submitMsg && (
            <p
              className={cn(
                'text-xs px-3 py-2 rounded-xl',
                submitMsg.startsWith('Submit failed') ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-500'
              )}
            >
              {submitMsg}
            </p>
          )}
          <DialogFooter className="border-t pt-4 mt-0 gap-2">
            <button
              type="button"
              onClick={() => setReasonFormOpen(false)}
              className="flex-1 sm:flex-initial py-2 px-4 bg-secondary rounded-xl text-sm hover:bg-secondary/70"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submitMutation.mutate()}
              disabled={!chatIdFromUrl || reason.trim().length < 10 || submitMutation.isPending}
              className="flex-1 sm:flex-initial py-2 px-4 bg-primary hover:bg-primary/90 text-white rounded-xl text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Submit
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {submitMsg && !reasonFormOpen && (
        <div className="bg-emerald-500/10 text-emerald-500 text-sm px-4 py-3 rounded-xl mb-4">{submitMsg}</div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 bg-card rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : appeals.length === 0 ? (
        <div className="text-center py-16">
          <AlertCircle className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No appeals yet</p>
        </div>
      ) : (
        <Queue>
          {appeals.map((a) => (
            <QueueItem
              key={a.id}
              status={a.status === 'pending' ? 'pending' : a.status === 'approved' ? 'active' : 'error'}
              title={
                <span className="flex items-center gap-2">
                  {statusIcon(a.status)}
                  <span
                    className={cn(
                      'text-xs px-2 py-0.5 rounded-full',
                      a.status === 'pending'
                        ? 'bg-amber-500/10 text-amber-500'
                        : a.status === 'approved'
                          ? 'bg-emerald-500/10 text-emerald-500'
                          : 'bg-red-500/10 text-red-400'
                    )}
                  >
                    {statusLabel(a.status)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleDateString('en-US')}
                  </span>
                </span>
              }
              meta={
                <div>
                  <p className="line-clamp-1">{a.reason}</p>
                  {a.adminNote && <p className="text-emerald-500/80 mt-0.5">Admin note: {a.adminNote}</p>}
                </div>
              }
            />
          ))}
        </Queue>
      )}
    </div>
  )
}

export default function AppealsDashboardPage() {
  return (
    <Suspense>
      <AppealsDashboardContent />
    </Suspense>
  )
}
