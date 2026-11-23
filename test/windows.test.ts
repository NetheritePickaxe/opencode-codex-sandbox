import { test } from "node:test"
import assert from "node:assert/strict"
import type { ResolvedPolicy } from "../src/policy.ts"
import {
  buildWindowsLaunch,
  buildWindowsProfile,
  encodeLaunchPayload,
  LAUNCH_PAYLOAD_ENV_ARG,
  WINDOWS_SANDBOX_ARG1,
} from "../src/windows.ts"

const policy: ResolvedPolicy = {
  mode: "workspace-write",
  network: false,
  writableRoots: [{ path: "D:\\ws", excluded: ["D:\\ws\\.git"] }],
  protectedNames: [".git", ".codex", ".agents", ".aws"],
}

function decodePayload(env: Record<string, string>): string[] {
  const count = parseInt(env.CODEX_SANDBOX_LAUNCH_COUNT, 10)
  const bytes = parseInt(env.CODEX_SANDBOX_LAUNCH_BYTES, 10)
  let payload = ""
  for (let i = 0; i < count; i++) {
    const chunk = env[`CODEX_SANDBOX_LAUNCH_${i}`]
    assert.ok(chunk !== undefined)
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 16 * 1024)
    payload += chunk
  }
  assert.equal(Buffer.byteLength(payload, "utf8"), bytes)
  return JSON.parse(payload)
}

test("workspace-write profile uses special kinds and restricted network", () => {
  const profile = buildWindowsProfile(policy) as any
  assert.equal(profile.type, "managed")
  assert.equal(profile.file_system.type, "restricted")
  assert.equal(profile.network, "restricted")
  const kinds = profile.file_system.entries.map((e: any) =>
    e.path.type === "special" ? `${e.path.value.kind}${e.path.value.subpath ? ":" + e.path.value.subpath : ""}:${e.access}` : "path",
  )
  assert.ok(kinds.includes("root:read"))
  assert.ok(kinds.includes("project_roots:write"))
  assert.ok(kinds.includes("tmpdir:write"))
  assert.ok(kinds.includes("slash_tmp:write"))
  assert.ok(kinds.includes("project_roots:.git:read"))
})

test("read-only profile keeps only root read", () => {
  const profile = buildWindowsProfile({ ...policy, mode: "read-only", writableRoots: [] }) as any
  assert.equal(profile.file_system.entries.length, 1)
  assert.equal(profile.file_system.entries[0].access, "read")
})

test("launch payload round-trips through env transport", () => {
  const launch = buildWindowsLaunch({
    policy,
    codexHome: "C:\\cache\\codex-home",
    cwd: "D:\\ws",
    workspaceRoots: ["D:\\ws"],
    desktopName: "CodexSandboxDesktop-0123456789abcdef0123456789abcdef",
    childEnv: { PATH: "C:\\Windows\\System32", FOO: "bar" },
    innerArgv: ["C:\\Windows\\System32\\cmd.exe", "/c", "echo hi"],
  })
  assert.deepEqual(launch.args, [WINDOWS_SANDBOX_ARG1, LAUNCH_PAYLOAD_ENV_ARG])
  const flags = decodePayload(launch.env)
  assert.equal(flags[0], "--codex-home")
  assert.ok(flags.includes("--windows-sandbox-level"))
  assert.ok(flags.includes("restricted-token"))
  const sep = flags.indexOf("--")
  assert.deepEqual(flags.slice(sep + 1), ["C:\\Windows\\System32\\cmd.exe", "/c", "echo hi"])
  const envJson = JSON.parse(flags[flags.indexOf("--env-json") + 1])
  assert.equal(envJson.FOO, "bar")
})

test("large payloads split into bounded chunks", () => {
  const big = "x".repeat(40_000) + "☃".repeat(5_000)
  const env = encodeLaunchPayload(JSON.stringify([big]))
  assert.ok(parseInt(env.CODEX_SANDBOX_LAUNCH_COUNT, 10) > 1)
  const flags = decodePayload(env)
  assert.equal(flags[0], big)
})

test("empty payload is rejected", () => {
  assert.throws(() => encodeLaunchPayload(""), /1\.\./)
})