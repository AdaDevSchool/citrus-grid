const FETCH_LIMIT = 2 * 1024 * 1024

export interface ExtractedCover {
  mime: string
  blobUrl: string
}

function be24(b: Uint8Array, o: number): number {
  return ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0
}

function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

function syncsafe32(b: Uint8Array, o: number): number {
  return (
    ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)
  )
}

function ascii(b: Uint8Array, o: number, len: number): string {
  return String.fromCharCode(...b.subarray(o, o + len))
}

function parseFlacPicture(buf: Uint8Array): Blob | null {
  if (ascii(buf, 0, 4) !== 'fLaC') return null
  let pos = 4
  while (pos + 4 <= buf.length) {
    const header = buf[pos]
    const type = header & 0x7f
    const len = be24(buf, pos + 1)
    const body = pos + 4
    if (len <= 0 || body + len > buf.length) return null
    if (type === 6) {
      const d = buf.subarray(body, body + len)
      const mimeLen = be32(d, 4)
      if (mimeLen <= 0 || mimeLen > 128 || 8 + mimeLen > d.length) return null
      const mime = ascii(d, 8, mimeLen)
      let o = 8 + mimeLen
      if (o + 4 > d.length) return null
      const descLen = be32(d, o)
      o += 4
      if (o + descLen + 4 > d.length) return null
      o += descLen
      o += 16
      const dataLen = be32(d, o)
      o += 4
      if (dataLen <= 0 || o + dataLen > d.length) return null
      return new Blob([d.slice(o, o + dataLen)], { type: mime || 'image/jpeg' })
    }
    if (header & 0x80) return null
    pos = body + len
  }
  return null
}

function parseMp3Picture(buf: Uint8Array): Blob | null {
  if (ascii(buf, 0, 3) !== 'ID3') return null
  const major = buf[3]
  const tagSize = syncsafe32(buf, 6)
  const end = Math.min(buf.length, 10 + tagSize)
  let pos = 10
  while (pos + 10 <= end) {
    const id = ascii(buf, pos, 4)
    if (id.charCodeAt(0) === 0) break
    const frameSize = major >= 4 ? syncsafe32(buf, pos + 4) : be32(buf, pos + 4)
    const data = pos + 10
    if (frameSize <= 0 || data + frameSize > end) break
    if (id === 'APIC') {
      const d = buf.subarray(data, data + frameSize)
      const enc = d[0]
      const mimeEnd = d.indexOf(0, 1)
      if (mimeEnd <= 1 || mimeEnd > 128) return null
      const mime = ascii(d, 1, mimeEnd - 1)
      const descLen = enc === 0 || enc === 3 ? 1 : 2
      const imgStart = mimeEnd + 1 + descLen
      if (imgStart >= d.length) return null
      return new Blob([d.slice(imgStart)], { type: mime || 'image/jpeg' })
    }
    pos = data + frameSize
  }
  return null
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      const need = limit - total
      if (value.length <= need) {
        chunks.push(value)
        total += value.length
      } else {
        chunks.push(value.subarray(0, need))
        total = limit
        await reader.cancel()
        break
      }
    }
  } catch {
  } finally {
    reader.releaseLock()
  }
  if (!chunks.length) return new Uint8Array(0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

const cache = new Map<string, Promise<ExtractedCover | null>>()

export function extractAudioCover(src: string): Promise<ExtractedCover | null> {
  const hit = cache.get(src)
  if (hit) return hit
  const p = doExtract(src)
  cache.set(src, p)
  return p
}

async function doExtract(src: string): Promise<ExtractedCover | null> {
  try {
    const url =
      src.startsWith('/') || src.startsWith('./') ? new URL(src, location.origin).href : src
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Range: `bytes=0-${FETCH_LIMIT - 1}` },
    })
    if (!res.ok && res.status !== 206) return null
    const buf = await readLimited(res, FETCH_LIMIT)
    if (buf.length < 4) return null
    const blob = ascii(buf, 0, 3) === 'ID3' ? parseMp3Picture(buf) : parseFlacPicture(buf)
    if (!blob) return null
    return { mime: blob.type, blobUrl: URL.createObjectURL(blob) }
  } catch {
    return null
  }
}
