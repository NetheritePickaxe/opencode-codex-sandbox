import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolvePolicy } from "../src/policy.ts"

test("workspace-write includes cwd with protected carveouts", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-policy-"))
  const policy = resolvePolicy({}, cwd)
  assert.equal(policy.mode, "workspace-write")
  assert.equal(policy.network, false)
  const root = policy.writableRoots.find((r) => r.path === fs.realpathSync(cwd))
  assert.ok(root)
  assert.ok(root.excluded.includes(path.join(root.path, ".git")))
  fs.rmSync(cwd, { recursive: true, force: true })
})

test("read-only has no writable roots", () => {
  const policy = resolvePolicy({ policy: "read-only" }, process.cwd())
  assert.deepEqual(policy.writableRoots, [])
})

test("danger-full-access enables network and skips roots", () => {
  const policy = resolvePolicy({ policy: "danger-full-access" }, process.cwd())
  assert.equal(policy.network, true)
  assert.deepEqual(policy.writableRoots, [])
})

test("extra writable roots are deduplicated", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-policy-"))
  const policy = resolvePolicy({ writableRoots: [cwd, cwd] }, cwd)
  const matches = policy.writableRoots.filter((r) => r.path === fs.realpathSync(cwd))
  assert.equal(matches.length, 1)
  fs.rmSync(cwd, { recursive: true, force: true })
})

test("invalid protected names are rejected", () => {
  assert.throws(() => resolvePolicy({ protectedNames: ["../evil"] }, process.cwd()), /invalid protected/)
  assert.throws(() => resolvePolicy({ protectedNames: ["a/b"] }, process.cwd()), /invalid protected/)
})