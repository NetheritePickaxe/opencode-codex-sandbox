// Ported from openai/codex (codex-rs/sandboxing/src/seatbelt.rs). Apache-2.0; see NOTICE.
import fs from "node:fs"
import type { ResolvedPolicy } from "./policy.ts"
import { BASE_POLICY, PREFERENCES_POLICY, NETWORK_POLICY, TLS_TRUST_POLICY } from "./sbpl.ts"

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

export interface SeatbeltCommand {
  file: string
  args: string[]
  env: Record<string, string>
}

function writeRuleForRoot(index: number, excludedKeys: string[]): string {
  const root = `(subpath (param "WRITABLE_ROOT_${index}"))`
  if (excludedKeys.length === 0) return root
  const parts = [root]
  for (const key of excludedKeys) {
    parts.push(`(require-not (literal (param "${key}")))`)
    parts.push(`(require-not (subpath (param "${key}")))`)
  }
  return `(require-all ${parts.join(" ")})`
}

export function buildSeatbeltCommand(policy: ResolvedPolicy, innerArgv: string[]): SeatbeltCommand {
  const params: Array<[string, string]> = []
  const sections: string[] = [BASE_POLICY, "; allow read-only file operations\n(allow file-read*)"]

  if (policy.writableRoots.length > 0) {
    const rules: string[] = []
    const anchorDenies: string[] = []
    policy.writableRoots.forEach((root, i) => {
      params.push([`WRITABLE_ROOT_${i}`, root.path])
      const excludedKeys: string[] = []
      root.excluded.forEach((p, j) => {
        const key = `WRITABLE_ROOT_${i}_EXCLUDED_${j}`
        params.push([key, p])
        excludedKeys.push(key)
        // Also bind the resolved target of a symlinked carveout so it cannot
        // be written through the symlink destination.
        try {
          const resolved = fs.realpathSync(p)
          if (resolved !== p) {
            const resolvedKey = `${key}_RESOLVED`
            params.push([resolvedKey, resolved])
            excludedKeys.push(resolvedKey)
          }
        } catch {
          // missing carveout: logical path binding is enough
        }
      })
      rules.push(writeRuleForRoot(i, excludedKeys))
      anchorDenies.push(
        `(deny file-write-unlink (require-all (literal (param "WRITABLE_ROOT_${i}")) (vnode-type DIRECTORY)))`,
      )
    })
    sections.push(`(allow file-write*\n  ${rules.join("\n  ")})`)
    sections.push(anchorDenies.join("\n"))
  }

  if (policy.network) {
    sections.push(`(allow network-outbound)\n(allow network-inbound)\n${NETWORK_POLICY}${TLS_TRUST_POLICY}`)
  }

  sections.push(PREFERENCES_POLICY)
  sections.push('(deny mach-lookup (xpc-service-name-prefix ""))')
  sections.push("(deny system-fcntl (fcntl-command 80 110))")

  const profile = sections.join("\n")
  const args = ["-p", profile, ...params.map(([k, v]) => `-D${k}=${v}`), "--", ...innerArgv]
  const env: Record<string, string> = { CODEX_SANDBOX: "seatbelt" }
  if (!policy.network) env.CODEX_SANDBOX_NETWORK_DISABLED = "1"
  return { file: SANDBOX_EXEC, args, env }
}