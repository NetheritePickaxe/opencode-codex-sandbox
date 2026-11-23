// Vendors the codex Windows sandbox Rust crates from the local codex clone
// into rust/ as a standalone cargo workspace. Reused by CI to track upstream:
// whole crates are copied verbatim; only the protocol shim is assembled from
// anchored fragments, and otel/http-client/runfiles are stubbed.
// Usage: node scripts/sync-rust.ts [codex-rs-dir]
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const SRC = path.resolve(process.argv[2] ?? path.join(ROOT, "codex", "codex-rs"))
const RUST = path.join(ROOT, "rust")
const VENDOR = path.join(RUST, "vendor")

// upstream crate dir -> vendor dir name
const CRATES: Record<string, string> = {
  "windows-sandbox-rs": "codex-windows-sandbox",
  "utils/pty": "codex-utils-pty",
  "utils/absolute-path": "codex-utils-absolute-path",
  "utils/path-uri": "codex-utils-path-uri",
  "utils/process": "codex-utils-process",
  "utils/string": "codex-utils-string",
  "utils/redacted-string": "codex-utils-redacted-string",
  "utils/cargo-bin": "codex-utils-cargo-bin",
  "windows-sandbox-rs/tests/support": "codex-windows-sandbox-test-support",
}
const INTERNAL = new Set([
  ...Object.values(CRATES),
  "codex-protocol",
  "codex-otel",
  "codex-http-client",
  "runfiles",
])

function die(msg: string): never {
  throw new Error(`sync-rust: ${msg}`)
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "BUILD.bazel" || entry.name === "target") continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

// --- upstream workspace dependency table -----------------------------------

function workspaceDeps(): Map<string, string> {
  const text = fs.readFileSync(path.join(SRC, "Cargo.toml"), "utf8")
  const start = text.indexOf("[workspace.dependencies]")
  if (start < 0) die("no [workspace.dependencies] in upstream root")
  const rest = text.slice(start + "[workspace.dependencies]".length)
  const end = rest.search(/^\[/m)
  const section = end < 0 ? rest : rest.slice(0, end)
  const deps = new Map<string, string>()
  const lines = section.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[i])
    if (!m) {
      i++
      continue
    }
    let value = m[2]
    let depth = (value.match(/\{/g) ?? []).length - (value.match(/\}/g) ?? []).length
    let j = i
    while (depth > 0 && j + 1 < lines.length) {
      j++
      value += "\n" + lines[j]
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
    }
    deps.set(m[1], value.trim())
    i = j + 1
  }
  return deps
}

const WS_DEPS = workspaceDeps()

function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  let inStr = false
  for (const ch of inner) {
    if (ch === '"' && !current.endsWith("\\")) inStr = !inStr
    if (!inStr) {
      if (ch === "{" || ch === "[") depth++
      if (ch === "}" || ch === "]") depth--
      if (ch === "," && depth === 0) {
        parts.push(current.trim())
        current = ""
        continue
      }
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseTable(value: string): Map<string, string> {
  const table = new Map<string, string>()
  if (!value.startsWith("{")) return table
  const inner = value.slice(1, value.lastIndexOf("}"))
  for (const part of splitTopLevel(inner)) {
    const eq = part.indexOf("=")
    if (eq > 0) table.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return table
}

function renderTable(table: Map<string, string>): string {
  return `{ ${[...table.entries()].map(([k, v]) => `${k} = ${v}`).join(", ")} }`
}

function mergeFeatures(base: string | undefined, extra: string | undefined): string | undefined {
  if (!extra) return base
  const parse = (v: string) =>
    (v.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1))
  const merged = [...new Set([...parse(base ?? "[]"), ...parse(extra)])]
  return `[${merged.map((f) => `"${f}"`).join(", ")}]`
}

// Resolve one dependency entry from a vendored crate manifest.
function resolveEntry(name: string, value: string): string {
  const entry = parseTable(value)
  if (entry.has("git")) {
    // runfiles comes from a bazel git repo upstream; we stub it.
    if (name === "runfiles") return `{ path = "../runfiles" }`
    return value
  }
  if (!entry.has("workspace")) {
    if (entry.has("path")) {
      const p = entry.get("path")!.replace(/"/g, "")
      const mapped = Object.entries(CRATES).find(([src]) => p === `../${src}` || p === src)
      if (mapped) entry.set("path", `"../${mapped[1]}"`)
      if (p === "../protocol") entry.set("path", `"../codex-protocol"`)
      return renderTable(entry)
    }
    return value
  }
  entry.delete("workspace")
  let base: Map<string, string>
  if (INTERNAL.has(name)) {
    base = new Map([["path", `"../${name}"`]])
  } else {
    const ws = WS_DEPS.get(name) ?? die(`no workspace entry for ${name}`)
    base = ws.startsWith("{") ? parseTable(ws) : new Map([["version", ws]])
  }
  const features = mergeFeatures(base.get("features"), entry.get("features"))
  for (const [k, v] of entry) base.set(k, v)
  if (features) base.set("features", features)
  else base.delete("features")
  return renderTable(base)
}

function rewriteManifest(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const pending: Array<{ parent: string; entry: string }> = []
  let section = ""
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Drop bin targets (we add our own launcher).
    if (/^\[\[bin\]\]/.test(line)) {
      i++
      while (i < lines.length && !/^\[/.test(lines[i])) i++
      continue
    }
    const sec = /^\[([^\]]+)\]\s*$/.exec(line)
    if (sec) {
      section = sec[1]
      // Drop workspace lints.
      if (section === "lints") {
        i++
        while (i < lines.length && !/^\[/.test(lines[i])) i++
        continue
      }
      // Section-form dependency: [dependencies.name] or [target...dependencies.name].
      const depSec = /^(.*dependencies)\.([A-Za-z0-9_-]+)$/.exec(section)
      if (depSec) {
        const body: string[] = []
        i++
        while (i < lines.length && !/^\[/.test(lines[i])) {
          body.push(lines[i])
          i++
        }
        const table = new Map<string, string>()
        let k = 0
        while (k < body.length) {
          const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(body[k])
          if (!kv) {
            k++
            continue
          }
          let value = kv[2]
          let depth = (value.match(/[\{\[]/g) ?? []).length - (value.match(/[\}\]]/g) ?? []).length
          let j = k
          while (depth > 0 && j + 1 < body.length) {
            j++
            value += "\n" + body[j]
            depth += (body[j].match(/[\{\[]/g) ?? []).length - (body[j].match(/[\}\]]/g) ?? []).length
          }
          table.set(kv[1], value.trim())
          k = j + 1
        }
        pending.push({ parent: depSec[1], entry: `${depSec[2]} = ${resolveEntry(depSec[2], renderTable(table))}` })
        continue
      }
      out.push(line)
      i++
      continue
    }
    const pkgKey = /^(version|edition|license)\.workspace\s*=\s*true\s*$/.exec(line)
    if (pkgKey && section === "package") {
      const values: Record<string, string> = { version: '"0.0.0"', edition: '"2024"', license: '"Apache-2.0"' }
      out.push(`${pkgKey[1]} = ${values[pkgKey[1]]}`)
      i++
      continue
    }
    const dep = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
    const isDepSection = /dependencies$/.test(section) || section.startsWith("dependencies.")
    if (dep && isDepSection && !section.startsWith("dependencies.")) {
      let value = dep[2]
      let depth = (value.match(/\{/g) ?? []).length - (value.match(/\}/g) ?? []).length
      let j = i
      while (depth > 0 && j + 1 < lines.length) {
        j++
        value += "\n" + lines[j]
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
      }
      out.push(`${dep[1]} = ${resolveEntry(dep[1], value.trim())}`)
      i = j + 1
      continue
    }
    out.push(line)
    i++
  }
  for (const { parent, entry } of pending) {
    const header = `[${parent}]`
    const idx = out.indexOf(header)
    if (idx >= 0) out.splice(idx + 1, 0, entry)
    else out.push(header, entry)
  }
  return out.join("\n")
}

// --- anchored fragment extraction ------------------------------------------

function findAnchor(lines: string[], needle: string): number {
  const idx = lines.findIndex((l) => l.trimStart().startsWith(needle))
  if (idx < 0) die(`anchor not found: ${needle}`)
  return idx
}

function walkBackAttrs(lines: string[], idx: number): number {
  // rustfmt separates items with a blank line; the doc/attribute block above an
  // item is contiguous (multi-line #[derive(...)] included). Walk back to it.
  while (idx > 0 && lines[idx - 1].trim() !== "") idx--
  return idx
}

function blockEnd(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === "}") return i + 1
  }
  die(`no block end after line ${start}`)
}

function extractRange(lines: string[], startAnchor: string, endAnchor: string): string {
  const start = walkBackAttrs(lines, findAnchor(lines, startAnchor))
  const end = walkBackAttrs(lines, findAnchor(lines, endAnchor))
  return lines.slice(start, end).join("\n").trimEnd() + "\n"
}

// --- protocol shim ----------------------------------------------------------

function buildProtocolShim(): void {
  const dst = path.join(VENDOR, "codex-protocol")
  fs.mkdirSync(path.join(dst, "src"), { recursive: true })
  const protoSrc = path.join(SRC, "protocol", "src")
  const write = (name: string, content: string) => fs.writeFileSync(path.join(dst, "src", name), content)

  // Verbatim permissions module (plus its inline test files).
  fs.copyFileSync(path.join(protoSrc, "permissions.rs"), path.join(dst, "src", "permissions.rs"))
  copyDir(path.join(protoSrc, "permissions"), path.join(dst, "src", "permissions"))
  for (const f of fs.readdirSync(protoSrc)) {
    if (f.startsWith("permissions") && f.endsWith("_tests.rs")) {
      fs.copyFileSync(path.join(protoSrc, f), path.join(dst, "src", f))
    }
  }
  // config_types verbatim; it only needs ReasoningEffort from openai_models.
  fs.copyFileSync(path.join(protoSrc, "config_types.rs"), path.join(dst, "src", "config_types.rs"))

  const models = fs.readFileSync(path.join(protoSrc, "models.rs"), "utf8").split(/\r?\n/)
  const modelsBlock = extractRange(models, "pub enum SandboxPermissions", "pub enum ResponseInputItem")
  write(
    "models.rs",
    `// Extracted from upstream protocol/src/models.rs (permission section only).
use std::io;
use std::num::NonZeroUsize;
use std::path::Path;

use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::ser::Serializer;
use ts_rs::TS;

use crate::permissions::FileSystemAccessMode;
use crate::permissions::FileSystemPath;
use crate::permissions::FileSystemSandboxEntry;
use crate::permissions::FileSystemSandboxKind;
use crate::permissions::FileSystemSandboxPolicy;
use crate::permissions::FileSystemSpecialPath;
use crate::permissions::LegacySandboxPolicyProjection;
use crate::permissions::NetworkSandboxPolicy;
use crate::permissions::RawFileSystemSandboxEntry;
use crate::protocol::SandboxPolicy;

${modelsBlock}`,
  )

  const protocol = fs.readFileSync(path.join(protoSrc, "protocol.rs"), "utf8").split(/\r?\n/)
  const protocolBlock = extractRange(protocol, "pub enum NetworkAccess", "pub struct Event")
  write(
    "protocol.rs",
    `// Extracted from upstream protocol/src/protocol.rs (sandbox policy types only).
use std::path::Path;
use std::path::PathBuf;
use std::str::FromStr;

use codex_utils_absolute_path::AbsolutePathBuf;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde::de::Error as _;
use strum_macros::Display;
use tracing::error;
use ts_rs::TS;

use crate::permissions::FileSystemSandboxPolicy;
use crate::permissions::NetworkSandboxPolicy;
use crate::permissions::RawFileSystemSandboxPolicy;
use crate::permissions::default_read_only_subpaths_for_writable_root;

${protocolBlock}`,
  )

  const openaiModels = fs.readFileSync(path.join(protoSrc, "openai_models.rs"), "utf8").split(/\r?\n/)
  const enumStart = walkBackAttrs(openaiModels, findAnchor(openaiModels, "pub enum ReasoningEffort"))
  const fromStrStart = findAnchor(openaiModels, "impl FromStr for ReasoningEffort")
  const reasoningBlock = openaiModels.slice(enumStart, blockEnd(openaiModels, fromStrStart)).join("\n")
  write(
    "openai_models.rs",
    `// Extracted from upstream protocol/src/openai_models.rs (ReasoningEffort only).
use std::fmt;
use std::str::FromStr;

use schemars::JsonSchema;
use schemars::r#gen::SchemaGenerator;
use schemars::schema::InstanceType;
use schemars::schema::Metadata;
use schemars::schema::Schema;
use schemars::schema::SchemaObject;
use schemars::schema::StringValidation;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as _;
use serde::ser::Serializer;
use ts_rs::TS;

${reasoningBlock}
`,
  )

  const shellEnv = fs.readFileSync(path.join(protoSrc, "shell_environment.rs"), "utf8")
  const constants = shellEnv
    .split(/\r?\n/)
    .filter((l) => /OPENAI_(FEDERATION_RULE_ID|IDENTITY_TOKEN_FILE)_ENV_VAR/.test(l) && l.includes("pub const"))
  if (constants.length !== 2) die(`expected 2 shell_environment constants, got ${constants.length}`)
  write("shell_environment.rs", `// Extracted from upstream protocol/src/shell_environment.rs.\n${constants.join("\n")}\n`)

  write(
    "lib.rs",
    `// Shim of upstream codex-protocol: only the modules the Windows sandbox needs.
pub mod config_types;
pub mod models;
pub mod openai_models;
pub mod permissions;
pub mod protocol;
pub mod shell_environment;
`,
  )

  fs.writeFileSync(
    path.join(dst, "Cargo.toml"),
    `[package]
name = "codex-protocol"
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"

[lib]
doctest = false

[dependencies]
codex-utils-absolute-path = { path = "../codex-utils-absolute-path" }
codex-utils-path-uri = { path = "../codex-utils-path-uri" }
codex-utils-redacted-string = { path = "../codex-utils-redacted-string" }
globset = "0.4"
schemars = "0.8.22"
serde = { version = "1", features = ["derive", "rc"] }
serde_json = "1"
strum = "0.27.2"
strum_macros = "0.28.0"
tracing = "0.1.44"
ts-rs = { version = "11", features = ["serde-json-impl", "no-serde-warnings"] }
wildmatch = "2"

[dev-dependencies]
pretty_assertions = "1.4.1"
tempfile = "3.23.0"
`,
  )
}

// --- stubs ------------------------------------------------------------------

function buildStubs(): void {
  const otel = path.join(VENDOR, "codex-otel")
  fs.mkdirSync(path.join(otel, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(otel, "Cargo.toml"),
    `[package]
name = "codex-otel"
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"

[dependencies]
codex-http-client = { path = "../codex-http-client" }
serde = { version = "1", features = ["derive"] }
`,
  )
  fs.writeFileSync(
    path.join(otel, "src", "lib.rs"),
    `// No-op telemetry stub: the standalone sandbox never exports metrics.
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsigMetricsSettings {
    pub environment: String,
}

pub fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings> {
    None
}

pub struct Metrics;

impl Metrics {
    pub fn counter(&self, _name: &str, _inc: u64, _tags: &[(&str, &str)]) -> Result<(), std::io::Error> {
        Ok(())
    }
}

pub fn global() -> Option<&'static Metrics> {
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OtelExporter {
    None,
    Statsig,
}

pub struct OtelSettings {
    pub headers_helper: Option<()>,
    pub http_client_factory: codex_http_client::HttpClientFactory,
    pub environment: String,
    pub service_name: String,
    pub service_version: String,
    pub codex_home: PathBuf,
    pub exporter: OtelExporter,
    pub trace_exporter: OtelExporter,
    pub metrics_exporter: OtelExporter,
    pub runtime_metrics: bool,
    pub span_attributes: HashMap<String, String>,
    pub tracestate: BTreeMap<String, String>,
}

pub struct OtelProvider;

impl OtelProvider {
    pub fn try_new(_settings: &OtelSettings) -> Result<Option<Self>, std::io::Error> {
        Ok(None)
    }

    pub fn metrics(&self) -> Option<&Metrics> {
        None
    }

    pub fn shutdown(&self) {}
}
`,
  )

  const http = path.join(VENDOR, "codex-http-client")
  fs.mkdirSync(path.join(http, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(http, "Cargo.toml"),
    `[package]
name = "codex-http-client"
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"
`,
  )
  fs.writeFileSync(
    path.join(http, "src", "lib.rs"),
    `// Stub: only the elevated WFP setup path constructs a factory, and the
// standalone sandbox never runs that path.
#[derive(Clone, Copy, Debug)]
pub enum OutboundProxyPolicy {
    ReqwestDefault,
}

#[derive(Clone, Debug)]
pub struct HttpClientFactory;

impl HttpClientFactory {
    pub fn new(_policy: OutboundProxyPolicy) -> Self {
        Self
    }
}
`,
  )

  const runfiles = path.join(VENDOR, "runfiles")
  fs.mkdirSync(path.join(runfiles, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(runfiles, "Cargo.toml"),
    `[package]
name = "runfiles"
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"
`,
  )
  fs.writeFileSync(
    path.join(runfiles, "src", "lib.rs"),
    `// Stub of the bazel runfiles crate: cargo builds never use bazel runfiles.
pub struct Runfiles;

impl Runfiles {
    pub fn create() -> Result<Self, std::io::Error> {
        Err(std::io::Error::other("runfiles are unavailable in cargo builds"))
    }
}

#[macro_export]
macro_rules! rlocation {
    ($runfiles:expr, $path:expr) => {
        None::<std::path::PathBuf>
    };
}
`,
  )
}

// --- workspace ---------------------------------------------------------------

function buildWorkspace(): void {
  fs.writeFileSync(
    path.join(RUST, "Cargo.toml"),
    `[workspace]
resolver = "2"
members = ["launcher", "vendor/*"]

[profile.release]
lto = true
strip = true
codegen-units = 1
`,
  )
  const launcher = path.join(RUST, "launcher")
  fs.mkdirSync(path.join(launcher, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(launcher, "Cargo.toml"),
    `[package]
name = "codex-sandbox-launcher"
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"

[dependencies]
codex-windows-sandbox = { path = "../vendor/codex-windows-sandbox" }
`,
  )
  fs.writeFileSync(
    path.join(launcher, "src", "main.rs"),
    `fn main() {
    codex_windows_sandbox::run_windows_sandbox_wrapper_main();
}
`,
  )
}

// --- main --------------------------------------------------------------------

fs.rmSync(VENDOR, { recursive: true, force: true })
fs.mkdirSync(VENDOR, { recursive: true })
for (const [src, name] of Object.entries(CRATES)) {
  const srcDir = path.join(SRC, src)
  const dstDir = path.join(VENDOR, name)
  copyDir(srcDir, dstDir)
  // The support crate is vendored separately; drop the nested copy.
  fs.rmSync(path.join(dstDir, "tests", "support"), { recursive: true, force: true })
  // build.rs only embeds the elevated setup helper's Windows manifest; we
  // ship neither that bin nor its manifest.
  fs.rmSync(path.join(dstDir, "build.rs"), { force: true })
  fs.rmSync(path.join(dstDir, "codex-windows-sandbox-setup.manifest"), { force: true })
  const manifest = path.join(dstDir, "Cargo.toml")
  let manifestText = fs.readFileSync(manifest, "utf8")
  manifestText = manifestText.replace(/^build = "build\.rs"\r?\n/m, "")
  let rewritten = rewriteManifest(manifestText)
  // Upstream enables winapi's "std" feature via workspace feature unification
  // (it aliases winapi::ctypes::c_void to std::ffi::c_void). The pty crate's
  // procthreadattr.rs relies on that alias; in this isolated workspace nothing
  // else pulls it in, so enable it explicitly.
  if (name === "codex-utils-pty") {
    rewritten = rewritten.replace(
      /winapi = \{ version = "0\.3\.9", features = \[\n/,
      'winapi = { version = "0.3.9", features = [\n    "std",\n',
    )
  }
  fs.writeFileSync(manifest, rewritten)
  console.log(`vendored ${src} -> vendor/${name}`)
}
buildProtocolShim()
console.log("assembled vendor/codex-protocol shim")
buildStubs()
console.log("wrote otel/http-client/runfiles stubs")
buildWorkspace()
console.log("wrote workspace + launcher")