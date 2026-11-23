import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { DEFAULT_CODEX_VERSION } from "./policy.ts"
import { extractTarGz } from "./tar.ts"

export function defaultCacheDir(): string {
  return path.join(os.homedir(), ".cache", "opencode-codex-sandbox")
}

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..")

// The standalone Rust launcher (rust/launcher) is a drop-in for
// `codex.exe --run-as-windows-sandbox`: same args, same env-chunk transport,
// but a few MB instead of the full ~365MB codex binary. Prefer a locally built
// artifact (or an explicit override) before falling back to a full codex.exe.
export function localLauncherCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return []
  const candidates: string[] = []
  if (env.CODEX_SANDBOX_LAUNCHER) candidates.push(env.CODEX_SANDBOX_LAUNCHER)
  for (const profile of ["release", "debug"]) {
    candidates.push(path.join(PACKAGE_ROOT, "rust", "target", profile, "codex-sandbox-launcher.exe"))
  }
  return candidates
}

export function findLocalLauncher(): string | undefined {
  for (const candidate of localLauncherCandidates()) {
    if (fs.existsSync(candidate) && probeCodexWrapper(candidate)) return candidate
  }
  return undefined
}

export const LAUNCHER_URL_ENV = "CODEX_SANDBOX_LAUNCHER_URL"

// Expands a launcher download template. `{version}` and `{arch}` are replaced;
// the URL should point at the raw .exe (e.g. a GitHub release asset).
export function fillLauncherUrl(template: string, version: string, arch: string): string {
  return template.split("{version}").join(version).split("{arch}").join(arch)
}

// Defaults the launcher download to this package's GitHub "latest" release once
// package.json declares a GitHub `repository`; otherwise download stays off.
// Data-driven so no repository slug is hardcoded.
function defaultLauncherUrl(): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"))
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url
    if (typeof repo !== "string") return undefined
    const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repo)
    if (!match) return undefined
    return `https://github.com/${match[1]}/${match[2]}/releases/latest/download/codex-sandbox-launcher-win32-{arch}.exe`
  } catch {
    return undefined
  }
}

// Downloads a prebuilt launcher when a source is configured (option, env, or
// package repository), caching it per version+arch. Any failure (missing URL,
// network, bad probe) returns undefined so the caller falls back to codex.exe.
export async function ensureLauncher(opts: {
  version?: string
  cacheDir?: string
  launcherUrl?: string
}): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined
  const template = opts.launcherUrl ?? process.env[LAUNCHER_URL_ENV] ?? defaultLauncherUrl()
  if (!template) return undefined
  const { arch } = windowsArch()
  const version = opts.version ?? DEFAULT_CODEX_VERSION
  const exe = path.join(opts.cacheDir ?? defaultCacheDir(), `launcher-${version}-win32-${arch}`, "codex-sandbox-launcher.exe")
  if (fs.existsSync(exe) && probeCodexWrapper(exe)) return exe
  try {
    const url = fillLauncherUrl(template, version, arch)
    const target = await cached(exe, async () => {
      process.stderr.write(`[codex-sandbox] downloading sandbox launcher (${version}) ...\n`)
      return downloadBuffer(url)
    })
    if (probeCodexWrapper(target)) return target
    process.stderr.write(`[codex-sandbox] downloaded launcher failed the wrapper probe; discarding\n`)
    fs.rmSync(path.dirname(target), { recursive: true, force: true })
    return undefined
  } catch (err) {
    process.stderr.write(`[codex-sandbox] launcher download failed (${(err as Error).message}); falling back\n`)
    return undefined
  }
}

function windowsArch(): { arch: string; triple: string } {
  return process.arch === "arm64"
    ? { arch: "arm64", triple: "aarch64-pc-windows-msvc" }
    : { arch: "x64", triple: "x86_64-pc-windows-msvc" }
}

export function localCodexCandidates(npmGlobalRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return []
  const { arch, triple } = windowsArch()
  const vendorRel = path.join("vendor", triple, "bin", "codex.exe")
  const candidates: string[] = []
  if (npmGlobalRoot) {
    candidates.push(
      path.join(npmGlobalRoot, "@openai", "codex", "node_modules", `@openai/codex-win32-${arch}`, vendorRel),
      path.join(npmGlobalRoot, `@openai/codex-win32-${arch}`, vendorRel),
      path.join(npmGlobalRoot, "@openai", "codex", vendorRel),
    )
  }
  candidates.push(path.join(os.homedir(), ".local", "bin", "codex.exe"))
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Programs", "codex", "codex.exe"))
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "codex.exe"))
  }
  return candidates
}

function npmGlobalRoot(): string | undefined {
  try {
    const result = spawnSync("npm.cmd", ["root", "-g"], { encoding: "utf8", timeout: 20_000, windowsHide: true, shell: true })
    const line = (result.stdout ?? "").trim().split(/\r?\n/).pop()
    return line && path.isAbsolute(line) ? line : undefined
  } catch {
    return undefined
  }
}

// The wrapper must understand both --run-as-windows-sandbox and the env
// transport; older codex builds lack them, so probe before trusting a local exe.
export function probeCodexWrapper(exe: string): boolean {
  const result = spawnSync(exe, ["--run-as-windows-sandbox", "--launch-payload-env"], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  })
  const stderr = result.stderr ?? ""
  return stderr.includes("chunk count") && !stderr.includes("unexpected")
}

// 0.169.0 added the cmd.exe /s /c script quoting; older builds CRT-escape the
// script's inner quotes, which breaks any command containing quoted paths.
export const MIN_LOCAL_CODEX_VERSION = "0.169.0"

export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.trim().split(".").map((part) => Number.parseInt(part, 10))
  const a = parse(version)
  const b = parse(minimum)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return true
}

export function codexExeVersion(exe: string): string | undefined {
  const result = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true })
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout ?? "")
  return match?.[1]
}

export function findLocalCodex(): string | undefined {
  for (const candidate of localCodexCandidates(npmGlobalRoot())) {
    if (!fs.existsSync(candidate)) continue
    const version = codexExeVersion(candidate)
    if (!version || !versionAtLeast(version, MIN_LOCAL_CODEX_VERSION)) {
      process.stderr.write(`[codex-sandbox] skipping local codex ${version ?? "(unknown version)"}: need >= ${MIN_LOCAL_CODEX_VERSION}\n`)
      continue
    }
    if (probeCodexWrapper(candidate)) return candidate
  }
  return undefined
}

const inflight = new Map<string, Promise<string>>()

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`opencode-codex-sandbox: download failed (${res.status} ${res.statusText}): ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function cached(target: string, produce: () => Promise<Buffer>): Promise<string> {
  if (fs.existsSync(target)) return Promise.resolve(target)
  const existing = inflight.get(target)
  if (existing) return existing
  const task = (async () => {
    const data = await produce()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, target)
    return target
  })().finally(() => inflight.delete(target))
  inflight.set(target, task)
  return task
}

export async function ensureCodexExe(opts: {
  version?: string
  cacheDir?: string
  codexPath?: string
  launcherUrl?: string
}): Promise<string> {
  if (opts.codexPath) return opts.codexPath
  const launcher = findLocalLauncher()
  if (launcher) {
    process.stderr.write(`[codex-sandbox] using local sandbox launcher: ${launcher}\n`)
    return launcher
  }
  const downloaded = await ensureLauncher({ version: opts.version, cacheDir: opts.cacheDir, launcherUrl: opts.launcherUrl })
  if (downloaded) {
    process.stderr.write(`[codex-sandbox] using downloaded sandbox launcher: ${downloaded}\n`)
    return downloaded
  }
  const local = findLocalCodex()
  if (local) {
    process.stderr.write(`[codex-sandbox] using local codex: ${local}\n`)
    return local
  }
  const version = opts.version ?? DEFAULT_CODEX_VERSION
  const { arch, triple } = windowsArch()
  const exe = path.join(opts.cacheDir ?? defaultCacheDir(), `codex-${version}-win32-${arch}`, "codex.exe")
  return cached(exe, async () => {
    // Platform packages are published as @openai/codex@<ver>-win32-<arch>.
    const url = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-win32-${arch}.tgz`
    process.stderr.write(`[codex-sandbox] downloading codex.exe (${version}) ...\n`)
    const entries = extractTarGz(await downloadBuffer(url))
    const entry = entries.find((e) => e.name === `package/vendor/${triple}/bin/codex.exe`)
    if (!entry) throw new Error(`opencode-codex-sandbox: codex.exe not found in ${url}`)
    return entry.data
  })
}

export async function ensureBwrap(opts: {
  version?: string
  cacheDir?: string
  bwrapPath?: string
}): Promise<string> {
  if (opts.bwrapPath) return opts.bwrapPath
  const version = opts.version ?? DEFAULT_CODEX_VERSION
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
  const bin = path.join(opts.cacheDir ?? defaultCacheDir(), `bwrap-${version}-${arch}`, "bwrap")
  const result = await cached(bin, async () => {
    const url = `https://github.com/openai/codex/releases/download/rust-v${version}/bwrap-${arch}-unknown-linux-musl.tar.gz`
    const entries = extractTarGz(await downloadBuffer(url))
    const entry = entries.find((e) => e.type === "0" && path.posix.basename(e.name) === "bwrap")
    if (!entry) throw new Error(`opencode-codex-sandbox: bwrap binary not found in ${url}`)
    return entry.data
  })
  fs.chmodSync(result, 0o755)
  return result
}