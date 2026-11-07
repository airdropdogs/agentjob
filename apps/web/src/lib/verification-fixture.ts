import { deflateSync } from 'node:zlib'
import { randomInt } from 'node:crypto'

// Small generated PNG; no image model or external asset is needed for test inputs.
function crc(data: Buffer) {
  let c = 0xffffffff
  for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}
export function imageFixture(colorIndex = randomInt(3)) {
  const colors = [{ name: 'red', rgb: [220, 30, 30] }, { name: 'purple', rgb: [150, 30, 180] }, { name: 'orange', rgb: [240, 140, 20] }]
  const color = colors[colorIndex % 3]
  const raw = Buffer.alloc(256 * (256 * 3 + 1))
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const square = x >= 30 && x < 100 && y >= 90 && y < 160
    const circle = (x - 185) ** 2 + (y - 125) ** 2 <= 35 ** 2
    const rgb = square ? color.rgb : circle ? [20, 80, 220] : [245, 245, 245]
    for (let c = 0; c < 3; c++) raw[y * 769 + 1 + x * 3 + c] = rgb[c]
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2
  return { bytes: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]), color: color.name }
}
