import path from "node:path"

export type ShellKind = "pwsh" | "powershell" | "cmd" | "zsh" | "fish" | "posix"

export function shellKind(shellPath: string): ShellKind {
  const base = path.basename(shellPath).toLowerCase().replace(/\.exe$/, "")
  if (base === "pwsh") return "pwsh"
  if (base === "powershell") return "powershell"
  if (base === "cmd") return "cmd"
  if (base === "zsh") return "zsh"
  if (base === "fish") return "fish"
  return "posix"
}

// Mirrors opencode's shell argument mapping (packages/core/src/shell/select.ts).
export function shellArgs(kind: ShellKind, command: string): string[] {
  switch (kind) {
    case "pwsh":
    case "powershell":
      return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    case "cmd":
      return ["/c", command]
    case "zsh":
      return ["+o", "nomatch", "-c", command]
    default:
      return ["-c", command]
  }
}

export function quoteArg(kind: ShellKind, arg: string): string {
  switch (kind) {
    case "pwsh":
    case "powershell":
      return `'${arg.replaceAll("'", "''")}'`
    case "cmd":
      return `"${arg.replaceAll('"', '\\"')}"`
    case "fish":
      return `'${arg.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    default:
      return `'${arg.replaceAll("'", `'\\''`)}'`
  }
}

export function joinCommand(kind: ShellKind, argv: string[]): string {
  const quoted = argv.map((a) => quoteArg(kind, a))
  if ((kind === "pwsh" || kind === "powershell") && quoted.length > 0) {
    // A quoted executable path needs the call operator in PowerShell.
    return `& ${quoted.join(" ")}`
  }
  return quoted.join(" ")
}