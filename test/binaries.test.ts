import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import {
  ensureLauncher,
  fillLauncherUrl,
  localCodexCandidates,
  localLauncherCandidates,
  versionAtLeast,
} from "../src/binaries.ts"

test("candidates cover npm nested, hoisted and legacy layouts", () => {
  if (process.platform !== "win32") return
  const root = "C:\\npm\\node_modules"
  const candidates = localCodexCandidates(root, { PATH: "" })
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  const vendor = path.join("vendor", triple, "bin", "codex.exe")
  assert.ok(candidates.includes(path.join(root, "@openai", "codex", "node_modules", `@openai/codex-win32-${arch}`, vendor)))
  assert.ok(candidates.includes(path.join(root, `@openai/codex-win32-${arch}`, vendor)))
  assert.ok(candidates.includes(path.join(root, "@openai", "codex", vendor)))
})

test("candidates include PATH entries", () => {
  if (process.platform !== "win32") return
  const candidates = localCodexCandidates(undefined, { PATH: `C:\\tools${path.delimiter}D:\\bin` })
  assert.ok(candidates.includes("C:\\tools\\codex.exe"))
  assert.ok(candidates.includes("D:\\bin\\codex.exe"))
})

test("versionAtLeast gates local codex on the cmd quoting fix", () => {
  assert.equal(versionAtLeast("0.164.0", "0.169.0"), false)
  assert.equal(versionAtLeast("0.169.0", "0.169.0"), true)
  assert.equal(versionAtLeast("0.170.1", "0.169.0"), true)
  assert.equal(versionAtLeast("1.0.0", "0.169.0"), true)
  assert.equal(versionAtLeast("0.169", "0.169.0"), true)
  assert.equal(versionAtLeast("garbage", "0.169.0"), false)
})

test("launcher candidates include override and rust target profiles", () => {
  if (process.platform !== "win32") return
  const candidates = localLauncherCandidates({ CODEX_SANDBOX_LAUNCHER: "C:\\bin\\launcher.exe" })
  assert.ok(candidates.includes("C:\\bin\\launcher.exe"))
  assert.ok(candidates.some((c) => c.endsWith(path.join("rust", "target", "release", "codex-sandbox-launcher.exe"))))
  assert.ok(candidates.some((c) => c.endsWith(path.join("rust", "target", "debug", "codex-sandbox-launcher.exe"))))
})

test("fillLauncherUrl expands version and arch tokens", () => {
  assert.equal(
    fillLauncherUrl("https://host/{version}/launcher-{arch}.exe", "0.169.0", "x64"),
    "https://host/0.169.0/launcher-x64.exe",
  )
  assert.equal(fillLauncherUrl("https://host/launcher.exe", "1.0.0", "arm64"), "https://host/launcher.exe")
})

test("ensureLauncher is a no-op without a configured URL", async () => {
  // An explicit empty string overrides any env var, so this is deterministic.
  assert.equal(await ensureLauncher({ launcherUrl: "" }), undefined)
})