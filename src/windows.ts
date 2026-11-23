// Launch/env transport ported from openai/codex (codex-rs/windows-sandbox-rs). Apache-2.0; see NOTICE.
import type { ResolvedPolicy } from "./policy.ts"

export const WINDOWS_SANDBOX_ARG1 = "--run-as-windows-sandbox"
export const LAUNCH_PAYLOAD_ENV_ARG = "--launch-payload-env"
const TRANSPORT_PREFIX = "CODEX_SANDBOX_LAUNCH_"
const CHUNK_BYTES = 16 * 1024
const MAX_BYTES = 16 * 1024 * 1024

interface ProfileEntry {
  path: { type: "special"; value: { kind: string; subpath?: string } } | { type: "path"; path: string }
  access: "read" | "write" | "deny"
}

// Standard managed profile understood by the legacy restricted-token backend.
// Special kinds (project_roots/tmpdir/slash_tmp) must be used instead of literal
// paths so the legacy writable-root projection matches the resolved policy.
export function buildWindowsProfile(policy: ResolvedPolicy): object {
  const entries: ProfileEntry[] = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
  ]
  if (policy.mode === "workspace-write") {
    entries.push(
      { path: { type: "special", value: { kind: "project_roots" } }, access: "write" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
    )
    for (const name of policy.protectedNames) {
      entries.push({
        path: { type: "special", value: { kind: "project_roots", subpath: name } },
        access: "read",
      })
    }
  }
  return {
    type: "managed",
    file_system: { type: "restricted", entries },
    network: policy.network ? "enabled" : "restricted",
  }
}

export interface WindowsLaunch {
  args: string[]
  env: Record<string, string>
}

export function buildWindowsLaunch(input: {
  policy: ResolvedPolicy
  codexHome: string
  cwd: string
  workspaceRoots: string[]
  desktopName: string
  childEnv: Record<string, string>
  innerArgv: string[]
}): WindowsLaunch {
  const flags: string[] = [
    "--codex-home", input.codexHome,
    "--command-cwd", input.cwd,
  ]
  for (const root of input.workspaceRoots) flags.push("--workspace-root", root)
  flags.push(
    "--permission-profile", JSON.stringify(buildWindowsProfile(input.policy)),
    "--env-json", JSON.stringify(input.childEnv),
    "--windows-sandbox-level", "restricted-token",
    "--windows-sandbox-private-desktop-name", input.desktopName,
    "--",
    ...input.innerArgv,
  )
  const payload = JSON.stringify(flags)
  const env = encodeLaunchPayload(payload)
  return { args: [WINDOWS_SANDBOX_ARG1, LAUNCH_PAYLOAD_ENV_ARG], env }
}

// Mirrors codex windows-sandbox-rs/src/environment_transport.rs: UTF-8 chunks
// of at most 16 KiB on char boundaries, plus COUNT/BYTES metadata variables.
export function encodeLaunchPayload(payload: string): Record<string, string> {
  const bytes = Buffer.byteLength(payload, "utf8")
  if (bytes === 0 || bytes > MAX_BYTES) {
    throw new Error(`sandbox launch payload must contain 1..=${MAX_BYTES} bytes`)
  }
  if (payload.includes("\0")) throw new Error("sandbox launch payload contains a NUL")
  const chunks: string[] = []
  let current = ""
  let currentBytes = 0
  for (const ch of payload) {
    const chBytes = Buffer.byteLength(ch, "utf8")
    if (currentBytes + chBytes > CHUNK_BYTES) {
      chunks.push(current)
      current = ""
      currentBytes = 0
    }
    current += ch
    currentBytes += chBytes
  }
  if (current) chunks.push(current)
  const env: Record<string, string> = {
    [`${TRANSPORT_PREFIX}COUNT`]: String(chunks.length),
    [`${TRANSPORT_PREFIX}BYTES`]: String(bytes),
  }
  chunks.forEach((chunk, i) => {
    env[`${TRANSPORT_PREFIX}${i}`] = chunk
  })
  return env
}

export function scrubTransportEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith(TRANSPORT_PREFIX)) delete env[key]
  }
}