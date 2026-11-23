import { test } from "node:test"
import assert from "node:assert/strict"
import type { ResolvedPolicy } from "../src/policy.ts"
import { buildBwrapCommand } from "../src/bwrap.ts"

const policy: ResolvedPolicy = {
  mode: "workspace-write",
  network: false,
  writableRoots: [{ path: "/ws", excluded: ["/ws/.git"] }],
  protectedNames: [".git"],
}

test("bwrap argv order and network isolation", () => {
  const cmd = buildBwrapCommand("/opt/bwrap", policy, ["/bin/bash", "-c", "x"], { kind: "none" })
  assert.equal(cmd.file, "/opt/bwrap")
  const a = cmd.args
  assert.deepEqual(a.slice(0, 4), ["/opt/bwrap", "--as-pid-1", "--new-session", "--die-with-parent"])
  const roRoot = a.indexOf("--ro-bind")
  const bindWs = a.indexOf("--bind")
  assert.ok(roRoot !== -1 && bindWs !== -1 && roRoot < bindWs)
  assert.deepEqual(a.slice(roRoot, roRoot + 3), ["--ro-bind", "/", "/"])
  assert.deepEqual(a.slice(bindWs, bindWs + 3), ["--bind", "/ws", "/ws"])
  assert.ok(a.includes("--unshare-net"))
  assert.ok(a.includes("--cap-drop"))
  const sep = a.indexOf("--")
  assert.deepEqual(a.slice(sep), ["--", "/bin/bash", "-c", "x"])
  assert.equal(cmd.env.CODEX_SANDBOX_NETWORK_DISABLED, "1")
})

test("missing carveout gets read-only tmpfs sentinel", () => {
  const cmd = buildBwrapCommand("/opt/bwrap", policy, ["/bin/bash", "-c", "x"], { kind: "none" })
  const i = cmd.args.indexOf("/ws/.git")
  assert.ok(i !== -1)
  assert.deepEqual(cmd.args.slice(i - 3, i + 2), ["--perms", "555", "--tmpfs", "/ws/.git", "--remount-ro"])
})

test("network enabled drops --unshare-net", () => {
  const cmd = buildBwrapCommand("/opt/bwrap", { ...policy, network: true }, ["/bin/bash", "-c", "x"], { kind: "none" })
  assert.ok(!cmd.args.includes("--unshare-net"))
  assert.equal(cmd.env.CODEX_SANDBOX_NETWORK_DISABLED, undefined)
})

test("WSL1 is rejected, WSL2 masks interop socket", () => {
  assert.throws(
    () => buildBwrapCommand("/opt/bwrap", policy, ["/bin/bash", "-c", "x"], { kind: "wsl1" }),
    /WSL1/,
  )
  const cmd = buildBwrapCommand("/opt/bwrap", policy, ["/bin/bash", "-c", "x"], { kind: "wsl2" })
  const i = cmd.args.indexOf("/run/WSL")
  assert.ok(i !== -1)
  assert.equal(cmd.args[i - 1], "--tmpfs")
})