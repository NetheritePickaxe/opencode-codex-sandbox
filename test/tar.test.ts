import { test } from "node:test"
import assert from "node:assert/strict"
import zlib from "node:zlib"
import { extractTarGz } from "../src/tar.ts"

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, "utf8")
  h.write("0000644\0", 100, 8)
  h.write("0000000\0", 108, 8)
  h.write("0000000\0", 116, 8)
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12)
  h.write("00000000000\0", 136, 12)
  h.write("        ", 148, 8)
  h.write(type, 156, 1)
  h.write("ustar\0", 257, 6)
  h.write("00", 263, 2)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8)
  return h
}

function pad(data: Buffer): Buffer {
  const rem = data.length % 512
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem)])
}

function makeTar(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  for (const f of files) {
    parts.push(header(f.name, f.data.length, "0"), pad(f.data))
  }
  parts.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(parts))
}

test("extracts file entries with content", () => {
  const tar = makeTar([
    { name: "package/vendor/x/bin/codex.exe", data: Buffer.from("MZ-fake-binary") },
    { name: "package/package.json", data: Buffer.from('{"name":"x"}') },
  ])
  const entries = extractTarGz(tar)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].name, "package/vendor/x/bin/codex.exe")
  assert.equal(entries[0].data.toString(), "MZ-fake-binary")
})

test("handles GNU long names and ustar prefix", () => {
  const longName = "package/" + "a".repeat(120) + "/codex.exe"
  const data = Buffer.from("long-name-content")
  const parts = [
    header("././@LongLink", longName.length + 1, "L"),
    pad(Buffer.from(longName + "\0")),
    header("placeholder", data.length, "0"),
    pad(data),
    Buffer.alloc(1024),
  ]
  const entries = extractTarGz(zlib.gzipSync(Buffer.concat(parts)))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, longName)
  assert.equal(entries[0].data.toString(), "long-name-content")
})

test("handles pax path override", () => {
  const longName = "package/" + "b".repeat(130) + "/bwrap"
  const data = Buffer.from("bwrap-content")
  const body = ` path=${longName}\n`
  let size = body.length + 2
  while (`${size}`.length + body.length !== size) size++
  const pax = Buffer.from(`${size}${body}`)
  const parts = [
    header("PaxHeaders", pax.length, "x"),
    pad(pax),
    header("short", data.length, "0"),
    pad(data),
    Buffer.alloc(1024),
  ]
  const entries = extractTarGz(zlib.gzipSync(Buffer.concat(parts)))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, longName)
})