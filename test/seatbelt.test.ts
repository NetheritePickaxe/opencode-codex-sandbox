import { test } from "node:test"
import assert from "node:assert/strict"
import type { ResolvedPolicy } from "../src/policy.ts"
import { buildSeatbeltCommand, SANDBOX_EXEC } from "../src/seatbelt.ts"

const policy: ResolvedPolicy = {
  mode: "workspace-write",
  network: false,
  writableRoots: [{ path: "/ws", excluded: ["/ws/.git"] }],
  protectedNames: [".git"],
}

test("argv wraps sandbox-exec with profile, params and inner command", () => {
  const cmd = buildSeatbeltCommand(policy, ["/bin/zsh", "-c", "echo hi"])
  assert.equal(cmd.file, SANDBOX_EXEC)
  assert.equal(cmd.args[0], "-p")
  const profile = cmd.args[1]
  assert.ok(profile.includes("(deny default)"))
  assert.ok(profile.includes("(allow file-read*)"))
  assert.ok(profile.includes('(param "WRITABLE_ROOT_0")'))
  assert.ok(profile.includes('(param "WRITABLE_ROOT_0_EXCLUDED_0")'))
  assert.ok(profile.includes("(deny system-fcntl (fcntl-command 80 110))"))
  assert.ok(cmd.args.includes("-DWRITABLE_ROOT_0=/ws"))
  assert.ok(cmd.args.includes("-DWRITABLE_ROOT_0_EXCLUDED_0=/ws/.git"))
  const tail = cmd.args.slice(-4)
  assert.deepEqual(tail, ["--", "/bin/zsh", "-c", "echo hi"])
  assert.equal(cmd.env.CODEX_SANDBOX, "seatbelt")
  assert.equal(cmd.env.CODEX_SANDBOX_NETWORK_DISABLED, "1")
})

test("network disabled means no network allows", () => {
  const cmd = buildSeatbeltCommand(policy, ["/bin/sh", "-c", "true"])
  assert.ok(!cmd.args[1].includes("(allow network-outbound)"))
})

test("network enabled adds outbound/inbound and TLS trust", () => {
  const cmd = buildSeatbeltCommand({ ...policy, network: true }, ["/bin/sh", "-c", "true"])
  assert.ok(cmd.args[1].includes("(allow network-outbound)"))
  assert.ok(cmd.args[1].includes("(allow network-inbound)"))
  assert.ok(cmd.args[1].includes("com.apple.TrustEvaluationAgent"))
  assert.equal(cmd.env.CODEX_SANDBOX_NETWORK_DISABLED, undefined)
})

test("read-only profile has no writable root params", () => {
  const cmd = buildSeatbeltCommand(
    { ...policy, mode: "read-only", writableRoots: [] },
    ["/bin/sh", "-c", "true"],
  )
  assert.ok(!cmd.args[1].includes("WRITABLE_ROOT_0"))
  assert.ok(!cmd.args.some((a) => a.startsWith("-DWRITABLE_ROOT")))
})