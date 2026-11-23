import zlib from "node:zlib"

export interface TarEntry {
  name: string
  type: string
  data: Buffer
}

function cstr(buf: Buffer): string {
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8")
}

function octal(buf: Buffer): number {
  const s = cstr(buf).trim()
  return s ? parseInt(s, 8) : 0
}

export function extractTarGz(buf: Buffer): TarEntry[] {
  const raw = zlib.gunzipSync(buf)
  const entries: TarEntry[] = []
  let offset = 0
  let pendingName: string | undefined
  let pendingPax: Record<string, string> = {}
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const size = octal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156] || 0x30)
    const data = raw.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === "L") {
      pendingName = cstr(data)
      continue
    }
    if (type === "x" || type === "g") {
      const text = data.toString("utf8")
      let pos = 0
      while (pos < text.length) {
        const space = text.indexOf(" ", pos)
        if (space === -1) break
        const len = parseInt(text.slice(pos, space), 10)
        if (!Number.isFinite(len)) break
        const record = text.slice(space + 1, pos + len)
        const eq = record.indexOf("=")
        if (eq !== -1) {
          const key = record.slice(0, eq)
          const value = record.slice(eq + 1).replace(/\n$/, "")
          if (type === "x") pendingPax[key] = value
        }
        pos += len
      }
      continue
    }

    let name = pendingName ?? cstr(header.subarray(0, 100))
    const prefix = cstr(header.subarray(345, 500))
    if (prefix && !pendingName) name = `${prefix}/${name}`
    if (pendingPax.path) name = pendingPax.path
    const entrySize = pendingPax.size ? parseInt(pendingPax.size, 10) : size
    pendingName = undefined
    pendingPax = {}

    if (type === "0" || type === "\0" || type === "7") {
      entries.push({ name, type: "0", data: data.subarray(0, entrySize) })
    } else if (type === "5") {
      entries.push({ name, type: "5", data: Buffer.alloc(0) })
    }
  }
  return entries
}