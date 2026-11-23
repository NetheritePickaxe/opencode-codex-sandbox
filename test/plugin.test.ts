import { test } from "node:test"
import assert from "node:assert/strict"
import plugin from "../src/index.ts"

function fakeCtx(options: Record<string, unknown>) {
  let hookCb: ((inv: any) => Promise<void>) | undefined
  const ctx = {
    options,
    location: { directory: process.cwd() },
    shell: {
      hook: async (name: string, cb: (inv: any) => Promise<void>) => {
        assert.equal(name, "create.before")
        hookCb = cb
        return { dispose: async () => {} }
      },
    },
  }
  return {
    ctx: ctx as any,
    fire: async (inv: any) => {
      assert.ok(hookCb, "hook was not registered")
      await hookCb(inv)
    },
    registered: () => hookCb !== undefined,
  }
}

function invocation() {
  return {
    command: "echo hi",
    cwd: process.cwd(),
    timeout: 0,
    shell: process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
    env: { PATH: process.env.PATH } as Record<string, string | undefined>,
  }
}

const platformOpts = process.platform === "linux" ? { bwrapPath: "/usr/bin/true" } : {}

test("setup rewrites shell invocation into the platform sandbox", async () => {
  const { ctx, fire } = fakeCtx(platformOpts)
  const cleanup = await plugin.setup(ctx)
  const inv = invocation()
  await fire(inv)
  if (process.platform === "win32") {
    assert.ok(inv.command.includes("--run-as-windows-sandbox"))
    assert.ok(inv.command.includes("--launch-payload-env"))
    assert.ok(inv.env.CODEX_SANDBOX_LAUNCH_COUNT)
    assert.ok(inv.env.CODEX_SANDBOX_LAUNCH_0)
  } else if (process.platform === "darwin") {
    assert.ok(inv.command.includes("sandbox-exec"))
    assert.equal(inv.env.CODEX_SANDBOX, "seatbelt")
  } else {
    assert.ok(inv.command.includes("--unshare-net"))
    assert.equal(inv.env.CODEX_SANDBOX, "bwrap")
  }
  assert.ok(inv.command.includes("echo hi") || process.platform === "win32")
  await cleanup?.()
})

test("disabled plugin registers nothing", async () => {
  const { ctx, registered } = fakeCtx({ enabled: false })
  const cleanup = await plugin.setup(ctx)
  assert.equal(registered(), false)
  assert.equal(cleanup, undefined)
})

test("danger-full-access passes commands through untouched", async () => {
  const { ctx, fire } = fakeCtx({ ...platformOpts, policy: "danger-full-access" })
  const cleanup = await plugin.setup(ctx)
  const inv = invocation()
  await fire(inv)
  assert.equal(inv.command, "echo hi")
  await cleanup?.()
})