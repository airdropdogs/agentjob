'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentAdapter } from '@assistant-ui/react'
import { FILE_TYPES, fileContentType, type ChatAttachment } from '@/lib/attachment-policy'

type Policy = { enabled: boolean; acceptedTypes: string[]; limits: Record<string, number> }
async function json(response: Response) {
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'File upload failed.')
  return data
}
export function useChatAttachmentAdapter(chatId: string, agentWallet: string) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [error, setError] = useState('')
  const files = useRef(new Map<string, ChatAttachment>())
  const ready = useRef(new Set<string>())
  const pendingCount = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/chat/attachments?agentWallet=${encodeURIComponent(agentWallet)}`, { signal: controller.signal })
      .then(json).then(setPolicy).catch(() => {})
    return () => controller.abort()
  }, [agentWallet])
  const adapter = useMemo<AttachmentAdapter | undefined>(() => !policy?.enabled ? undefined : ({
    accept: [...policy.acceptedTypes, ...Object.entries(FILE_TYPES).filter(([, type]) => policy.acceptedTypes.includes(type)).map(([ext]) => '.' + ext)].join(','),
    async *add({ file }) {
      setError('')
      const type = fileContentType(file.name)
      if (!type || !policy.acceptedTypes.includes(type) || file.size > policy.limits.attachment_max_mb * 1048576 || pendingCount.current >= policy.limits.attachment_max_files) {
        const message = `Choose a supported file up to ${policy.limits.attachment_max_mb} MB. Maximum ${policy.limits.attachment_max_files} files per message.`
        setError(message); throw new Error(message)
      }
      pendingCount.current++
      let id: string | undefined
      try {
        const { attachment, uploadUrl } = await fetch('/api/chat/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, agentWallet, name: file.name, size: file.size }), signal: AbortSignal.timeout(30000),
        }).then(json)
        id = attachment.id
        files.current.set(attachment.id, attachment)
        const base = { id: attachment.id, name: file.name, type: type.startsWith('image/') ? 'image' : 'document', contentType: type, file }
        yield { ...base, status: { type: 'running', reason: 'uploading', progress: 0 } }
        const uploaded = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': attachment.contentType }, body: file, signal: AbortSignal.timeout(120000) })
        if (!uploaded.ok) throw new Error('Upload failed. Please try again.')
        await fetch('/api/chat/attachments', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: attachment.id }), signal: AbortSignal.timeout(30000) }).then(json)
        if (!files.current.has(attachment.id)) return
        ready.current.add(attachment.id)
        yield { ...base, status: { type: 'requires-action', reason: 'composer-send' } }
      } catch (e) {
        if (!id || files.current.delete(id)) pendingCount.current--
        setError(e instanceof Error ? e.message : 'Upload failed.'); throw e
      }
    },
    async send(attachment) {
      if (!ready.current.has(attachment.id)) throw new Error('Wait for uploads to finish, or remove failed files before sending.')
      return { ...attachment, status: { type: 'complete' }, content: [] }
    },
    async remove(attachment) { setError(''); ready.current.delete(attachment.id); if (files.current.delete(attachment.id)) pendingCount.current-- },
  }), [policy, chatId, agentWallet])
  return { adapter, error, metadata: (id: string) => files.current.get(id),
    reset: () => { files.current.clear(); ready.current.clear(); pendingCount.current = 0 } }
}
