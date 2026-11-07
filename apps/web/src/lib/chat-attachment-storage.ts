import { S3Client, PutObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { matchesFileHeader } from './attachment-policy'
import { inspectVideo } from './video-metadata'

export function attachmentsConfigured() {
  return process.env.CHAT_ATTACHMENTS_ENABLED === 'true' &&
    ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'].every(k => Boolean(process.env[k]))
}
function storage() {
  if (!attachmentsConfigured()) throw new Error('Attachments are not enabled.')
  return new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  })
}
const bucket = () => process.env.R2_BUCKET_NAME!
export async function uploadUrl(id: string, type: string, size: number) {
  return getSignedUrl(storage(), new PutObjectCommand({ Bucket: bucket(), Key: `pending/${id}`, ContentType: type, ContentLength: size }), {
    expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']),
  })
}
export async function finalizeObject(id: string, type: string, size: number, maxSeconds?: number) {
  const client = storage()
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket(), Key: `pending/${id}` }))
  if (head.ContentLength !== size || head.ContentType !== type || !head.ETag) throw new Error('Uploaded file does not match its declared size or type.')
  const sample = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: `pending/${id}`, Range: 'bytes=0-511', IfMatch: head.ETag }))
  if (!sample.Body || !matchesFileHeader(type, await sample.Body.transformToByteArray())) throw new Error('File contents do not match the selected format.')
  const duration = type === 'video/mp4' ? await inspectVideo(size, async (start, end) => {
    const range = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: `pending/${id}`, Range: `bytes=${start}-${end}`, IfMatch: head.ETag }))
    if (!range.Body) throw new Error('Video metadata unavailable.')
    return range.Body.transformToByteArray()
  }, maxSeconds ?? 0) : undefined
  // Copy a verified version to an immutable key. Replaying PUT cannot change a sent file.
  await client.send(new CopyObjectCommand({ Bucket: bucket(), Key: `files/${id}`, CopySource: `${bucket()}/pending/${id}`, CopySourceIfMatch: head.ETag }))
  // Keep the staging object until lifecycle cleanup so a lost DB commit can retry verification.
  return duration
}
export async function downloadUrl(id: string, name: string, type: string, preview = false) {
  return getSignedUrl(storage(), new GetObjectCommand({ Bucket: bucket(), Key: `files/${id}`,
    ResponseContentType: type, ResponseContentDisposition: `${preview && (type.startsWith('image/') || type === 'video/mp4') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  }), { expiresIn: 600 })
}
export async function deleteAttachmentObjects(id: string) {
  const client = storage()
  for (const prefix of ['pending', 'files']) await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: `${prefix}/${id}` }))
}
