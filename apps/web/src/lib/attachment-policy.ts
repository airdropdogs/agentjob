export const FILE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
export const ATTACHMENT_LIMITS = {
  attachment_output_max_files: { default: 4, min: 0, max: 10 },
  attachment_output_daily_mb: { default: 500, min: 1, max: 10000 },
  attachment_video_max_files: { default: 1, min: 0, max: 5 },
  attachment_video_max_mb: { default: 50, min: 1, max: 250 },
  attachment_video_max_seconds: { default: 120, min: 1, max: 1800 },
  attachment_video_retention_days: { default: 7, min: 1, max: 30 },
  attachment_max_files: { default: 4, min: 1, max: 10 },
  attachment_max_mb: { default: 10, min: 1, max: 25 },
  attachment_daily_mb: { default: 50, min: 1, max: 1000 },
  attachment_retention_days: { default: 7, min: 1, max: 30 },
} as const
export type ChatAttachment = { id: string; name: string; contentType: string; size: number; durationSeconds?: number }
export function outputContentType(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  return extension === 'mp4' ? 'video/mp4' : ['png', 'jpg', 'jpeg', 'webp'].includes(extension ?? '') ? fileContentType(name) : null
}
export function fileContentType(name: string) {
  return FILE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? null
}
export function validAttachmentSetting(key: string, value: string) {
  const limit = ATTACHMENT_LIMITS[key as keyof typeof ATTACHMENT_LIMITS]
  return !limit || (/^\d+$/.test(value) && Number(value) >= limit.min && Number(value) <= limit.max)
}
export function matchesFileHeader(type: string, bytes: Uint8Array) {
  const hex = Array.from(bytes.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('')
  if (type === 'image/png') return hex.startsWith('89504e470d0a1a0a')
  if (type === 'image/jpeg') return hex.startsWith('ffd8ff')
  if (type === 'image/webp') return hex.startsWith('52494646') && hex.slice(16, 24) === '57454250'
  if (type === 'application/pdf') return hex.startsWith('255044462d')
  if (type === 'video/mp4') return hex.slice(8, 16) === '66747970'
  if (type.includes('officedocument')) return hex.startsWith('504b0304')
  if (type.startsWith('text/')) {
    // Streaming decoder allows a UTF-8 character split by the small header sample.
    try { return !new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }).includes('\0') } catch { return false }
  }
  return false
}
