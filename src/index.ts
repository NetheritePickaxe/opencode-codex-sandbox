import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { canonicalPath, resolvePolicy, type SandboxOptions } from "./policy.ts"
import { buildSeatbeltCommand } from "./seatbelt.ts"
import { buildBwrapCommand } from "./bwrap.ts"
import { buildWindowsLaunch, scrubTransportEnv } from "./windows.ts"
import { createPrivateDesktop, type PrivateDesktop } from "./desktop.ts"
import { defaultCacheDir, ensureBwrap, ensureCodexExe } from "./binaries.ts"
import { joinCommand, shellArgs, shellKind } from "./shell.ts"

interface Ready {
  bwrapPath?: string
  codexExe?: string
  codexHome?: string
  desktop?: PrivateDesktop
}

async function init(opts: SandboxOptions): Promise<Ready> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir()
  if (process.platform === "win32") {
    const codexExe = await ensureCodexExe({ version: opts.codexVersion, cacheDir, codexPath: opts.codexPath, launcherUrl: opts.launcherUrl })
    const codexHome = opts.codexHome ?? path.join(cacheDir, "codex-home")
    fs.mkdirSync(codexHome, { recursive: true })
    const desktop = await createPrivateDesktop()
    return { codexExe, codexHome, desktop }
  }
  if (process.platform === "linux") {
    const bwrapPath = await ensureBwrap({ version: opts.codexVersion, cacheDir, bwrapPath: opts.bwrapPath })
    return { bwrapPath }
  }
  return {}
}

export default Plugin.define({
  id: "codex-sandbox",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as SandboxOptions
    if (opts.enabled === false) return

    let readyPromise: Promise<Ready> | undefined
    const getReady = (): Promise<Ready> => {
      if (!readyPromise) {
        readyPromise = init(opts).catch((err) => {
          readyPromise = undefined
          throw err
        })
      }
      return readyPromise
    }

    const registration = await ctx.shell.hook("create.before", async (inv) => {
      const cwd = inv.cwd || ctx.location.directory
      const policy = resolvePolicy(opts, cwd)
      if (policy.mode === "danger-full-access") return

      const ready = await getReady()
      const kind = shellKind(inv.shell)
      // The codex wrapper only recognizes backslash-separated cmd.exe paths for
      // its /s /c script quoting; forward slashes silently break quoted commands.
      const shellPath = process.platform === "win32" ? inv.shell.replace(/\//g, "\\") : inv.shell
      const innerArgv = [shellPath, ...shellArgs(kind, inv.command)]

      if (process.platform === "darwin") {
        const cmd = buildSeatbeltCommand(policy, innerArgv)
        inv.command = joinCommand(kind, [cmd.file, ...cmd.args])
        Object.assign(inv.env, cmd.env)
        return
      }

      if (process.platform === "linux") {
        const cmd = buildBwrapCommand(ready.bwrapPath!, policy, innerArgv)
        inv.command = joinCommand(kind, [cmd.file, ...cmd.args])
        Object.assign(inv.env, cmd.env)
        return
      }

      if (process.platform === "win32") {
        const projectRoots: string[] = []
        for (const root of [cwd, ...(opts.writableRoots ?? [])]) {
          const canonical = canonicalPath(root)
          if (!projectRoots.includes(canonical)) projectRoots.push(canonical)
        }
        scrubTransportEnv(inv.env)
        const childEnv: Record<string, string> = {}
        for (const [key, value] of Object.entries(inv.env)) {
          if (value !== undefined) childEnv[key] = value
        }
        const launch = buildWindowsLaunch({
          policy,
          codexHome: ready.codexHome!,
          cwd: canonicalPath(cwd),
          workspaceRoots: projectRoots,
          desktopName: ready.desktop!.name,
          childEnv,
          innerArgv,
        })
        inv.command = joinCommand(kind, [ready.codexExe!, ...launch.args])
        Object.assign(inv.env, launch.env)
        return
      }

      throw new Error(`opencode-codex-sandbox: unsupported platform ${process.platform}`)
    })

    return async () => {
      await registration.dispose()
      const ready = await readyPromise?.catch(() => undefined)
      ready?.desktop?.close()
    }
  },
})