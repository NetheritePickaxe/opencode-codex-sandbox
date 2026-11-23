// Ported from openai/codex (codex-rs/linux-sandbox/src/bwrap.rs). Apache-2.0; see NOTICE.
import fs from "node:fs"
import type { ResolvedPolicy } from "./policy.ts"

export interface BwrapCommand {
  file: string
  args: string[]
  env: Record<string, string>
}

export interface WslInfo {
  kind: "none" | "wsl1" | "wsl2"
}

export function detectWsl(): WslInfo {
  try {
    const version = fs.readFileSync("/proc/version", "utf8")
    if (/WSL1/i.test(version)) return { kind: "wsl1" }
    if (/microsoft/i.test(version)) return { kind: "wsl2" }
  } catch {
    // not linux or no procfs
  }
  return { kind: "none" }
}

const WSLG_DISTRO_ALIAS = "/mnt/wslg/distro"

export function buildBwrapCommand(
  bwrapPath: string,
  policy: ResolvedPolicy,
  innerArgv: string[],
  wsl: WslInfo = detectWsl(),
): BwrapCommand {
  if (wsl.kind === "wsl1") {
    throw new Error("opencode-codex-sandbox: WSL1 has no user namespaces and is not supported; use WSL2 or native Linux")
  }

  const args: string[] = [
    bwrapPath,
    "--as-pid-1",
    "--new-session",
    "--die-with-parent",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
  ]

  const roots = [...policy.writableRoots].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length,
  )
  for (const root of roots) {
    if (wsl.kind === "wsl2" && isUnder(root.path, WSLG_DISTRO_ALIAS)) {
      throw new Error(`opencode-codex-sandbox: writable root under ${WSLG_DISTRO_ALIAS} is a duplicate of / on WSL2 and cannot be sandboxed: ${root.path}`)
    }
    args.push("--bind", root.path, root.path)
    for (const sub of root.excluded) {
      let stat: fs.Stats | undefined
      try {
        stat = fs.statSync(sub)
      } catch {
        stat = undefined
      }
      if (stat) {
        args.push("--ro-bind", sub, sub)
      } else {
        // Non-existent metadata dir: create a read-only placeholder so the
        // sandboxed process cannot mkdir it and escape the carveout.
        args.push("--perms", "555", "--tmpfs", sub, "--remount-ro", sub)
      }
    }
  }

  if (wsl.kind === "wsl2") {
    // The WSL interop socket can launch arbitrary Windows processes: mask it.
    args.push("--tmpfs", "/run/WSL")
    if (fs.existsSync(WSLG_DISTRO_ALIAS)) {
      args.push("--perms", "000", "--tmpfs", WSLG_DISTRO_ALIAS, "--remount-ro", WSLG_DISTRO_ALIAS)
    }
    for (const arg of innerArgv.slice(0, 1)) {
      if (isUnder(arg, WSLG_DISTRO_ALIAS)) {
        throw new Error(`opencode-codex-sandbox: shell under ${WSLG_DISTRO_ALIAS} cannot be sandboxed on WSL2: ${arg}`)
      }
    }
  }

  args.push("--unshare-user", "--unshare-pid", "--unshare-ipc")
  if (!policy.network) args.push("--unshare-net")
  args.push("--proc", "/proc", "--cap-drop", "ALL", "--", ...innerArgv)

  const env: Record<string, string> = { CODEX_SANDBOX: "bwrap" }
  if (!policy.network) env.CODEX_SANDBOX_NETWORK_DISABLED = "1"
  return { file: bwrapPath, args, env }
}

function isUnder(p: string, parent: string): boolean {
  return p === parent || p.startsWith(parent + "/")
}