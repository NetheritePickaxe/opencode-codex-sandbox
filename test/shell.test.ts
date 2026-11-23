import { test } from "node:test"
import assert from "node:assert/strict"
import { joinCommand, quoteArg, shellArgs, shellKind } from "../src/shell.ts"

test("shell kind detection strips .exe", () => {
  assert.equal(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh")
  assert.equal(shellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell")
  assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe"), "cmd")
  assert.equal(shellKind("/bin/zsh"), "zsh")
  assert.equal(shellKind("/usr/bin/fish"), "fish")
  assert.equal(shellKind("/bin/bash"), "posix")
  assert.equal(shellKind("/bin/sh"), "posix")
})

test("shell args mirror opencode mapping", () => {
  assert.deepEqual(shellArgs("pwsh", "ls"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "ls"])
  assert.deepEqual(shellArgs("cmd", "dir"), ["/c", "dir"])
  assert.deepEqual(shellArgs("zsh", "ls"), ["+o", "nomatch", "-c", "ls"])
  assert.deepEqual(shellArgs("posix", "ls"), ["-c", "ls"])
})

test("posix single-quote escaping", () => {
  assert.equal(quoteArg("posix", "plain"), "'plain'")
  assert.equal(quoteArg("posix", "a'b"), "'a'\\''b'")
  assert.equal(quoteArg("posix", 'a"b$c'), `'a"b$c'`)
})

test("powershell quoting and call operator", () => {
  assert.equal(quoteArg("pwsh", "a'b"), "'a''b'")
  const line = joinCommand("pwsh", ["C:\\path with space\\codex.exe", "--flag"])
  assert.equal(line, "& 'C:\\path with space\\codex.exe' '--flag'")
})

test("cmd quoting uses double quotes", () => {
  assert.equal(quoteArg("cmd", "C:\\a b\\x.exe"), '"C:\\a b\\x.exe"')
  const line = joinCommand("cmd", ["C:\\a\\codex.exe", "--flag"])
  assert.equal(line, '"C:\\a\\codex.exe" "--flag"')
})

test("fish escaping", () => {
  assert.equal(quoteArg("fish", "a'b"), "'a\\'b'")
})