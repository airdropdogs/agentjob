import { createFile } from 'mp4box'

// Read bounded metadata ranges, skipping media data. No decoding or transcoding.
export async function inspectVideo(size: number, read: (start: number, end: number) => Promise<Uint8Array>, maxSeconds: number) {
  const file = createFile(false)
  let duration: number | undefined
  let invalid = false
  file.onError = () => { invalid = true }
  file.onReady = info => {
    const seconds = [info.duration / info.timescale, ...info.tracks.map(t => t.duration / t.timescale)]
    invalid = info.isFragmented || !info.videoTracks.length || info.videoTracks.some(t => !/^avc[13]\./.test(t.codec)) || seconds.some(n => !Number.isFinite(n) || n <= 0)
    duration = Math.max(...seconds)
  }
  let offset = 0, readBytes = 0
  for (let i = 0; i < 32 && duration === undefined && !invalid && offset < size; i++) {
    const bytes = await read(offset, Math.min(size - 1, offset + 65535))
    readBytes += bytes.byteLength
    if (!bytes.length || readBytes > 2 * 1024 * 1024) throw new Error('Video metadata is too large.')
    const buffer = bytes.slice().buffer as Parameters<typeof file.appendBuffer>[0]
    buffer.fileStart = offset
    const next = file.appendBuffer(buffer)
    offset = next && next > offset ? next : offset + bytes.length
  }
  if (invalid || duration === undefined || duration > maxSeconds) throw new Error(`Use a non-fragmented H.264 MP4 up to ${maxSeconds} seconds with readable metadata.`)
  return duration
}
