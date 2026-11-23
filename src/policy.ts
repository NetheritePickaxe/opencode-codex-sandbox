// Sandbox policy model derived from openai/codex permissions. Apache-2.0; see NOTICE.
import fs from "node:fs"
import path from "node:path"

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export interface SandboxOptions {
  enabled?: boolean
  policy?: SandboxMode
  network?: boolean
  writableRoots?: string[]
  excludeTmp?: boolean
  protectedNames?: string[]
  codexVersion?: string
  codexPath?: string
  launcherUrl?: string
  bwrapPath?: string
  cacheDir?: string
  codexHome?: string
}

export interface WritableRoot {
  path: string
  excluded: string[]
}

export interface ResolvedPolicy {
  mode: SandboxMode
  network: boolean
  writableRoots: WritableRoot[]
  protectedNames: string[]
}

export const DEFAULT_PROTECTED_NAMES = [".git", ".codex", ".agents", ".aws"]
export const DEFAULT_CODEX_VERSION = "0.169.0"

export function canonicalPath(p: string): string {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

function validateProtectedName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`invalid protected path name: ${JSON.stringify(name)}`)
  }
}

export function resolvePolicy(opts: SandboxOptions, cwd: string): ResolvedPolicy {
  const mode = opts.policy ?? "workspace-write"
  const network = opts.network ?? false
  const protectedNames = opts.protectedNames ?? DEFAULT_PROTECTED_NAMES
  for (const name of protectedNames) validateProtectedName(name)

  if (mode === "danger-full-access" || mode === "read-only") {
    return { mode, network: mode === "danger-full-access" ? true : network, writableRoots: [], protectedNames }
  }

  const roots: string[] = [canonicalPath(cwd)]
  for (const extra of opts.writableRoots ?? []) roots.push(canonicalPath(extra))

  if (!opts.excludeTmp && process.platform !== "win32") {
    if (fs.existsSync("/tmp")) roots.push(canonicalPath("/tmp"))
    const tmpdir = process.env.TMPDIR
    if (tmpdir && fs.existsSync(tmpdir)) roots.push(canonicalPath(tmpdir))
  }

  const seen = new Set<string>()
  const writableRoots: WritableRoot[] = []
  for (const root of roots) {
    if (seen.has(root)) continue
    seen.add(root)
    writableRoots.push({
      path: root,
      excluded: protectedNames.map((name) => path.join(root, name)),
    })
  }
  return { mode, network, writableRoots, protectedNames }
}