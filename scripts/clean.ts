// Removes everything the plugin downloaded or created in its cache dir
// (codex.exe, bwrap, codex-home state). Local codex installs are untouched.
// Usage: node scripts/clean.ts [cacheDir]
import fs from "node:fs"
import path from "node:path"
import { defaultCacheDir } from "../src/binaries.ts"

function dirSize(dir: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

const dir = process.argv[2] ?? defaultCacheDir()
if (!fs.existsSync(dir)) {
  console.log(`nothing to clean: ${dir} does not exist`)
} else {
  const bytes = dirSize(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`removed ${dir} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
}
console.log("note: capability-SID ACEs written to workspace directories persist; remove unknown S-1-5-21-* entries from those folders' ACLs if desired")