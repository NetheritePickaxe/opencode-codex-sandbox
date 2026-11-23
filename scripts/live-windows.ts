// Live Windows sandbox verification. Downloads codex.exe, creates a private
// desktop, and runs real commands through the restricted-token sandbox.
// Usage: node scripts/live-windows.ts
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureCodexExe } from "../src/binaries.ts"
import { createPrivateDesktop } from "../src/desktop.ts"
import { canonicalPath, resolvePolicy } from "../src/policy.ts"
import { buildWindowsLaunch } from "../src/windows.ts"

function assertOk(cond: boolean, label: string, detail?: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`)
  if (!cond) process.exitCode = 1
}

const workspace = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-live-ws-")))
const outside = path.join(os.homedir(), `sbx-deny-${process.pid}.txt`)
const codexHome = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-live-home-")))

console.log("resolving sandbox exe (local launcher preferred, then codex install, otherwise cached/downloaded)...")
const exe = await ensureCodexExe({})
console.log(`sandbox exe: ${exe}`)

const desktop = await createPrivateDesktop()
console.log(`desktop: ${desktop.name}`)

const policy = resolvePolicy({}, workspace)
const childEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v

function run(command: string): { status: number | null; stdout: string; stderr: string } {
  const launch = buildWindowsLaunch({
    policy,
    codexHome,
    cwd: workspace,
    workspaceRoots: [workspace],
    desktopName: desktop.name,
    childEnv,
    innerArgv: [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), "/c", command],
  })
  const result = spawnSync(exe, launch.args, {
    env: { ...process.env, ...launch.env },
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

try {
  const echo = run("echo hello-sandbox")
  assertOk(echo.status === 0 && echo.stdout.includes("hello-sandbox"), "echo runs inside sandbox", `exit=${echo.status} stderr=${echo.stderr.slice(0, 300)}`)

  const writeIn = run(`echo data > "${path.join(workspace, "inside.txt")}"`)
  assertOk(writeIn.status === 0 && fs.existsSync(path.join(workspace, "inside.txt")), "write inside workspace allowed", `exit=${writeIn.status} stderr=${writeIn.stderr.slice(0, 300)}`)

  const writeOut = run(`echo data > "${outside}"`)
  assertOk(writeOut.status !== 0 && !fs.existsSync(outside), "write outside workspace denied", `exit=${writeOut.status} stderr=${writeOut.stderr.slice(0, 300)}`)

  const readSys = run("type C:\\Windows\\win.ini")
  assertOk(readSys.status === 0 && readSys.stdout.length > 0, "full-disk read allowed", `exit=${readSys.status}`)

  const gitDir = path.join(workspace, ".git")
  fs.mkdirSync(gitDir)
  const writeGit = run(`echo data > "${path.join(gitDir, "config")}"`)
  assertOk(writeGit.status !== 0, "write to .git carveout denied", `exit=${writeGit.status} stderr=${writeGit.stderr.slice(0, 300)}`)

  const netEnv = run("echo %SBX_NONET_ACTIVE% %HTTP_PROXY%")
  assertOk(netEnv.stdout.includes("1") && netEnv.stdout.includes("127.0.0.1:9"), "offline env markers present", netEnv.stdout.trim())
} finally {
  desktop.close()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(codexHome, { recursive: true, force: true })
  fs.rmSync(outside, { force: true })
}