'use client'

import { createContext, useContext, useMemo, useState, useRef, useEffect, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider, useExternalStoreRuntime,
  ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ActionBarPrimitive,
  AttachmentPrimitive, useAui, AuiIf, useAuiState, type TextMessagePartProps, type ThreadMessageLike,
} from '@assistant-ui/react'
import { Paperclip, X, ArrowDown, ArrowUp, Check, Copy, Square } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { displayAgentReply } from '@/lib/agent-reply'

import { useChatAttachmentAdapter } from './attachment-adapter'
import type { ChatAttachment } from '@/lib/attachment-policy'
const AttachmentError = createContext('')
const OutputFiles = createContext<Record<string, ChatAttachment[]>>({})

type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }
const plugins = { cjk, code, math, mermaid }
const convertMessage = (message: ThreadMessageLike) => message

// Keep payments, task polling and persistence owned by the existing page.
export function ChatRuntime({ messages, busy, disabled, typingId, typingText, onSend, children, chatId, agentWallet }: {
  chatId: string
  agentWallet: string
  messages: ChatMessage[]
  busy: boolean
  disabled: boolean
  typingId: string | null
  typingText: string
  onSend: (message: { text: string; attachments?: ChatAttachment[] }) => Promise<void>
  children: ReactNode
}) {
  const upload = useChatAttachmentAdapter(chatId, agentWallet)
  const rendered = useMemo<ThreadMessageLike[]>(() => messages.map(message => {
    const safeText = message.role === 'assistant' ? displayAgentReply(message.content) : message.content
    return {
      id: message.id,
      role: message.role,
      ...(message.role === 'user' ? { attachments: (message.attachments ?? []).map(a => ({ ...a, type: a.contentType.startsWith('image/') ? 'image' : 'document', status: { type: 'complete' as const }, content: [] })) } : {}),
      content: [{ type: 'text' as const, text: safeText !== message.content ? safeText : typingId === message.id ? typingText : safeText }],
    }
  }), [messages, typingId, typingText])
  const runtime = useExternalStoreRuntime({
    messages: rendered,
    convertMessage,
    isRunning: busy,
    isDisabled: disabled,
    adapters: { attachments: upload.adapter },
    onNew: async message => {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const attachments = (message.attachments ?? []).map(a => upload.metadata(a.id)).filter((a): a is ChatAttachment => Boolean(a))
      if (text.trim() || attachments.length) { await onSend({ text, attachments }); upload.reset() }
    },
  })
  return <AssistantRuntimeProvider runtime={runtime}><OutputFiles.Provider value={Object.fromEntries(messages.map(m => [m.id, m.attachments ?? []]))}><AttachmentError.Provider value={upload.error}>{children}</AttachmentError.Provider></OutputFiles.Provider></AssistantRuntimeProvider>
}

function AssistantText({ text }: TextMessagePartProps) {
  return <Streamdown plugins={plugins} className="min-w-0 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{text}</Streamdown>
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-1 py-4">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] bg-[#0d0d0d] px-4 py-2.5 text-base leading-6 text-white dark:bg-[#ececec] dark:text-[#0d0d0d] sm:max-w-[70%]">
        <MessagePrimitive.Attachments components={{ Attachment: SentAttachment }} />
        <MessagePrimitive.Parts />
      </div>
      <ActionBarPrimitive.Root hideWhenRunning autohide="always" className="flex">
        <CopyMessage />
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

function SentAttachment() {
  const attachment = useAuiState(s => s.attachment)
  const url = '/api/chat/attachments?id=' + encodeURIComponent(attachment.id)
  return <AttachmentPrimitive.Root className="mb-2">
    <a href={url} target="_blank" rel="noreferrer" className="block rounded-lg border border-current/20 p-2 text-sm">
      {attachment.type === 'image' && <img src={url + '&preview=1'} alt={attachment.name} className="mb-1 max-h-60 rounded-lg object-contain" />}
      <AttachmentPrimitive.Name />
    </a>
  </AttachmentPrimitive.Root>
}
function ComposerAttachment() {
  const attachment = useAuiState(s => s.attachment)
  const { status } = attachment
  const file = attachment.file
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (!file || attachment.type !== 'image') { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file, attachment.type])
  if (attachment.type === 'image') return (
    <AttachmentPrimitive.Root title={attachment.name} className="relative size-28 shrink-0 overflow-hidden rounded-2xl border bg-muted/30">
      {preview ? <img src={preview} alt={attachment.name} className="size-full object-cover" /> : <Paperclip aria-hidden="true" className="m-auto mt-10 size-6 text-muted-foreground" />}
      {status.type === 'running' && <span role="status" className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1 text-center text-xs text-white">Uploading…</span>}
      {status.type === 'incomplete' && <span role="alert" className="absolute inset-x-0 bottom-0 bg-red-700 px-2 py-1 text-center text-xs text-white">Upload failed</span>}
      <AttachmentPrimitive.Remove aria-label={`Remove ${attachment.name}`} title="Remove image" className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-white text-black shadow-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2">
        <X className="size-4" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
  return <AttachmentPrimitive.Root className="flex max-w-60 items-center gap-2 rounded-lg border p-2 text-xs">
    <Paperclip className="size-4 shrink-0" /><span className="truncate"><AttachmentPrimitive.Name /></span>
    {status.type === 'running' && <span role="status" className="animate-pulse">Uploading…</span>}
    {status.type === 'incomplete' && <span className="text-red-500">Failed</span>}
    <AttachmentPrimitive.Remove aria-label="Remove file"><X className="size-4" /></AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>
}

function AssistantMessage() {
  const hasText = useAuiState(s => s.message.content.some(part => part.type === 'text' && part.text.length > 0))
  const id = useAuiState(s => s.message.id)
  const files = useContext(OutputFiles)[id] ?? []
  if (!hasText && !files.length) return null
  return (
    <MessagePrimitive.Root className="group min-w-0 py-4 text-base leading-7">
      <MessagePrimitive.Parts components={{ Text: AssistantText }} />
      {files.map(file => <DeliveredFile key={file.id} file={file} />)}
      <ActionBarPrimitive.Root hideWhenRunning className="-ml-2 mt-1 flex">
        <CopyMessage />
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

function DeliveredFile({ file }: { file: ChatAttachment }) {
  const [failed, setFailed] = useState(false)
  const [version, setVersion] = useState(0)
  const player = useRef<HTMLVideoElement>(null)
  const position = useRef(0)
  const url = '/api/chat/attachments?id=' + encodeURIComponent(file.id)
  return <div className="my-3 max-w-xl rounded-xl border p-3">
    {file.contentType === 'video/mp4' ? <video ref={player} controls playsInline preload="none" aria-label={file.name}
      className="max-h-96 w-full rounded-lg" src={url + '&preview=1&v=' + version}
      onTimeUpdate={() => { position.current = player.current?.currentTime ?? 0 }}
      onLoadedMetadata={() => { if (player.current && position.current) player.current.currentTime = position.current }}
      onError={() => setFailed(true)} /> : <img src={url + '&preview=1'} alt={file.name} className="max-h-96 rounded-lg object-contain" onError={() => setFailed(true)} />}
    {failed && <p role="alert" className="text-sm">File unavailable or expired. {file.contentType === 'video/mp4' && <button onClick={() => { setFailed(false); setVersion(v => v + 1) }} className="underline">Retry playback</button>}</p>}
    <a href={url} target="_blank" rel="noreferrer" className="mt-2 block break-all text-sm underline">Download {file.name}</a>
  </div>
}

function CopyMessage() {
  return <ActionBarPrimitive.Copy aria-label="Copy message" title="Copy message" className="flex size-8 items-center justify-center rounded-lg text-[#5d5d5d] hover:bg-black/5 focus-visible:outline-2 dark:text-[#cdcdcd] dark:hover:bg-white/10">
    <AuiIf condition={s => s.message.isCopied}><Check className="size-4" /></AuiIf>
    <AuiIf condition={s => !s.message.isCopied}><Copy className="size-4" /></AuiIf>
  </ActionBarPrimitive.Copy>
}

export function ChatMessages({ status, waiting, progress }: { status: string; waiting: boolean; progress?: { message: string; percent?: number } | null }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-8 pt-8 sm:px-6 sm:pt-12">
        <div className="mx-auto w-full max-w-3xl min-w-0">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {waiting && (
            <div role="status" aria-live="polite" className="flex items-center py-5">
              <span aria-hidden="true" className="size-3 rounded-full bg-current motion-safe:animate-pulse" />
              <span className={progress ? "ml-3 text-sm text-muted-foreground" : "sr-only"}>{progress ? progress.message + (progress.percent != null ? " - " + progress.percent + "%" : "") : status === 'waiting' ? 'Agent is thinking…' : 'Sending your message…'}</span>
            </div>
          )}
        </div>
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom aria-label="Scroll to latest message" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-background p-2 shadow-sm disabled:hidden">
        <ArrowDown className="size-4" />
      </ThreadPrimitive.ScrollToBottom>
    </div>
  )
}

export function ChatComposer({ placeholder, disabled, status, onStop, costLabel, costDescription, onCostRefresh }: {
  placeholder: string; disabled: boolean; status: string; onStop: () => void; costLabel?: string; costDescription?: string; onCostRefresh?: () => void
}) {
  const runtime = useAui()
  const enabled = useAuiState(s => s.thread.capabilities.attachments)
  const attachments = useAuiState(s => s.composer.attachments)
  const uploading = attachments.some(a => a.status.type === 'running')
  const failed = attachments.some(a => a.status.type === 'incomplete')
  const blocked = uploading || failed
  const uploadError = useContext(AttachmentError)
  return (
    <ComposerPrimitive.Root onSubmitCapture={e => { if (blocked) { e.preventDefault(); e.stopPropagation() } }} onKeyDownCapture={e => { if (blocked && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation() } }} onDragOver={e => { if (enabled && !disabled) e.preventDefault() }} onDrop={e => { if (enabled && !disabled && e.dataTransfer.files.length) { e.preventDefault(); for (const file of Array.from(e.dataTransfer.files)) void runtime.composer.addAttachment(file).catch(() => {}) } }} className="mx-auto flex w-full max-w-3xl flex-wrap items-end gap-2 rounded-[28px] border border-[#e5e5e5] bg-white p-2 focus-within:border-[#d0d0d0] dark:border-transparent dark:bg-[#212121]">
      <div className="flex w-full flex-wrap gap-2 empty:hidden"><ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} /></div>
      {attachments.length > 0 && <p className="w-full px-3 text-xs text-muted-foreground">File handling depends on this Agent. Uploading does not verify its image or document skills.</p>}
      {blocked && <p role="status" className="w-full px-3 text-xs text-muted-foreground">{uploading ? 'Wait for uploads to finish before sending.' : 'Remove failed files or upload them again before sending.'}</p>}
      {uploadError && <p role="alert" className="w-full px-3 text-sm text-red-500">{uploadError}</p>}
      {enabled && <ComposerPrimitive.AddAttachment disabled={disabled} aria-label="Attach files" title="Attach files" className="flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"><Paperclip className="size-5" /></ComposerPrimitive.AddAttachment>}
      <ComposerPrimitive.Input aria-label="Message" placeholder={placeholder} disabled={disabled}
        className="min-h-9 max-h-52 min-w-0 flex-1 resize-none bg-transparent py-1.5 pl-3 pr-1 text-base leading-6 outline-none placeholder:text-[#8e8e8e]" rows={1} />
      <div className="flex shrink-0 items-center gap-2">
        {costLabel && (onCostRefresh
          ? <button type="button" onClick={onCostRefresh} title={costDescription} className="whitespace-nowrap text-xs font-medium text-primary underline">{costLabel}</button>
          : <span aria-live="polite" title={costDescription} className="whitespace-nowrap text-xs font-medium tabular-nums text-neutral-500 dark:text-neutral-400">{costLabel}</span>)}
        {status === 'waiting' || status === 'sending' ? (
          <button type="button" aria-label="Cancel generation" title="Cancel generation. Payments already made are not automatically refunded." disabled={status === 'sending'} onClick={onStop}
            className="flex size-9 items-center justify-center rounded-full bg-[#0d0d0d] text-white disabled:opacity-30 dark:bg-white dark:text-black"><Square className="size-3 fill-current" /></button>
        ) : (
          <ComposerPrimitive.Send aria-label="Send message" title={blocked ? 'Finish uploading or remove failed files before sending' : 'Send message'} disabled={disabled || blocked}
            className="flex size-9 items-center justify-center rounded-full bg-[#0d0d0d] text-white disabled:opacity-30 dark:bg-white dark:text-black"><ArrowUp className="size-5" /></ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  )
}
