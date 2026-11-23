# opencode-codex-sandbox

把 [OpenAI Codex CLI](https://github.com/openai/codex) 的操作系统级沙盒剥离成 [opencode](https://opencode.ai) V2 插件：opencode 里每条 shell 命令默认在沙盒中执行——全盘可读、仅工作区可写、默认禁网。

## 平台实现

| 平台 | 机制 | 来源 |
|---|---|---|
| macOS | Seatbelt：JS 移植 Codex 的 profile 生成，`/usr/bin/sandbox-exec -p <profile> -D WRITABLE_ROOT_n=… -- <shell> -c <cmd>` | `codex-rs/sandboxing/src/seatbelt.rs` + `*.sbpl` |
| Linux | bubblewrap：`--ro-bind / /` + 可写根 `--bind` + `.git` 等只读回填 + `--unshare-net` 禁网；静态 musl bwrap 自动下载 | `codex-rs/linux-sandbox/src/bwrap.rs` |
| Windows | Codex 官方 `codex.exe --run-as-windows-sandbox`（restricted token + WRITE_RESTRICTED + 工作区 capability SID ACE），**无需管理员、无需 setup**；插件通过 FFI 创建并持有私有桌面，payload 走 `CODEX_SANDBOX_LAUNCH_*` 环境分块传输 | `codex-rs/windows-sandbox-rs/` |

接入点：`ctx.shell.hook("create.before")` 原地改写命令与环境变量，保留 opencode 内置 shell 工具的权限询问、后台执行、输出截断等全部行为。`danger-full-access` 策略下不包装，直接透传。

## 安装

需要 opencode V2（`@opencode/plugin` 2.x）与 Node ≥ 22.6（或 Bun）。

项目级：把本仓库放到 `.opencode/plugins/codex-sandbox/`（目录内含 `package.json` 与 `src/`），并在该目录执行 `npm install`（Windows 需要 koffi 的原生预编译）。

或在 `opencode.json` 中引用：

```jsonc
{
  "plugins": [
    { "package": "opencode-codex-sandbox", "options": { "policy": "workspace-write" } }
  ]
}
```

本地路径形式：

```jsonc
{
  "plugins": [
    { "package": "./.opencode/plugins/codex-sandbox", "options": { "network": false } }
  ]
}
```

## 配置项（options）

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后命令不套沙盒 |
| `policy` | `"workspace-write"` | `read-only` / `workspace-write` / `danger-full-access` |
| `network` | `false` | 允许沙盒内联网（Windows 见下方限制） |
| `writableRoots` | `[]` | 额外可写目录；工作区目录始终可写 |
| `excludeTmp` | `false` | 不把 `/tmp`、`$TMPDIR` 列为可写（仅 POSIX） |
| `protectedNames` | `[".git",".codex",".agents",".aws"]` | 可写根下保持只读的子目录名 |
| `codexVersion` | `"0.169.0"` | Windows codex.exe / Linux bwrap 的下载版本（release tag `rust-v<ver>`） |
| `codexPath` / `bwrapPath` | 自动 | 手动指定二进制，跳过下载 |
| `launcherUrl` | 自动 | Windows launcher 下载模板，`{version}`/`{arch}` 占位；也可用环境变量 `CODEX_SANDBOX_LAUNCHER_URL`。默认取 `package.json` 的 GitHub `repository`（`/releases/latest/download/codex-sandbox-launcher-win32-{arch}.exe`），未声明则不下载 |
| `cacheDir` | `~/.cache/opencode-codex-sandbox` | 二进制与状态缓存目录 |
| `codexHome` | `<cacheDir>/codex-home` | Windows 沙盒状态目录（capability SID 等） |

## 二进制获取

Windows 按以下顺序解析沙盒可执行文件：

1. `codexPath` 选项手动指定；
2. **独立 launcher**（约 3.5MB，与 `codex.exe --run-as-windows-sandbox` 完全同协议）：
   - 本机构建产物：`rust/target/{release,debug}/codex-sandbox-launcher.exe`，或 `CODEX_SANDBOX_LAUNCHER` 环境变量指定；
   - 否则按 `launcherUrl` / `CODEX_SANDBOX_LAUNCHER_URL` / `package.json` 的 GitHub `repository` 运行时下载并缓存到 `cacheDir`（见下方「Rust 独立 launcher」）；
3. **本机已安装的 codex**：npm 全局包（`npm root -g` 下 `@openai/codex` 的平台子包，含嵌套/提升/旧版 vendor 三种布局）、`~/.local/bin/codex.exe`、`%LOCALAPPDATA%\Programs\codex\`、PATH 中的 `codex.exe`。要求版本 **≥ 0.169.0**（该版本起才有 `cmd.exe /s /c` 引号处理，旧版会破坏带引号路径的命令），并探测 `--run-as-windows-sandbox --launch-payload-env` 协议兼容性，不满足则跳过；
4. 缓存目录中已下载的 codex.exe；
5. 首次下载：npm registry 的 `@openai/codex@<ver>-win32-<arch>` tarball，提取 `vendor/<triple>/bin/codex.exe`（**约 365MB**，0.169.0 实测）。

Linux：GitHub release 资产 `bwrap-<arch>-unknown-linux-musl.tar.gz`（静态链接，非 setuid，依赖 unprivileged user namespaces，体积小）。
macOS：无二进制依赖。

## Rust 独立 launcher（体积优化）

完整 `codex.exe` 约 365MB，但 Windows 沙盒实际只用到其中 `windows-sandbox-rs` crate。`rust/` 把该 crate 及其依赖闭包剥离成独立 cargo workspace，编出仅数 MB 的 `codex-sandbox-launcher.exe`，与 `codex.exe --run-as-windows-sandbox` 同协议、可直接替换。

- **零保真损失**：沙盒 crate 源码逐字 vendor（`rust/vendor/codex-windows-sandbox` 等），不改一行；仅 `codex-protocol` 用锚点片段拼出最小 shim（permissions/config_types 逐字，models/protocol/openai_models 只取沙盒相关类型），`otel`/`http-client`/`runfiles` 用 no-op stub（独立 launcher 不上报遥测、不走 elevated setup）。
- **`rust/vendor/` 是生成物（已 `.gitignore`）**：由 `scripts/sync-rust.ts` 从上游重建，不进仓库。本地构建前必须先跑一次 sync；CI 每次构建都会重新生成。
- **构建**：`node scripts/sync-rust.ts [codex-rs-dir]` 从上游生成 `rust/vendor/`（默认读本地 `codex/codex-rs`，该克隆已 gitignore、需自行 clone；CI 用 sparse-checkout 自带），再 `cd rust && cargo build --release -p codex-sandbox-launcher`。产物在 `rust/target/release/codex-sandbox-launcher.exe`，插件自动优先使用。
- **运行时下载**：`ensureLauncher` 按 `launcherUrl` / `CODEX_SANDBOX_LAUNCHER_URL` / `package.json` 的 GitHub `repository` 拼出 `.../releases/latest/download/codex-sandbox-launcher-win32-{arch}.exe`，首次运行下到 `cacheDir` 并做协议探测；任何一步失败都静默回退到 codex.exe。`.github/workflows/release-launcher.yml`（打 `launcher-v*` tag 或手动）构建 x64/arm64 两个 .exe 并附到 GitHub release。
- **测试**：`cargo test -p codex-protocol --lib`（58）+ `cargo test -p codex-windows-sandbox --lib -- --skip unified_exec::tests::`（263）。`unified_exec::tests::*` 是需要安装 elevated setup 服务的端到端 exec 测试，独立 launcher 不带该服务，故跳过；该路径由 `npm run live:windows` 实测覆盖。
- **CI 跟进上游**：`.github/workflows/sync-upstream.yml` 每周（或手动）拉取最新 `rust-v*` tag，sparse-checkout crate 闭包 → 重生成 → Windows 构建+测试 → 开 PR；patch 升级可自动合并，minor/major 留人工 review。`rust/UPSTREAM_VERSION` 记录上次同步版本。

## 卸载

opencode 没有插件卸载钩子（setup 返回的 cleanup 只在服务关闭/插件重载时运行，用于释放桌面句柄，不会删缓存）。完整卸载步骤：

1. 从 `opencode.json` 的 `plugins` 中移除本插件；
2. 运行 `npm run clean`（即 `node scripts/clean.ts [cacheDir]`），删除下载的二进制与 codex-home 状态；本机已安装的 codex 不受影响；
3. 可选：Windows 沙盒曾在工作区目录写入 capability SID 的持久 ACE，如需清理，删除这些目录 ACL 中未知的 `S-1-5-21-*` 账户条目。

## 安全边界与已知限制

- **Windows 禁网是环境级的**（`SBX_NONET_ACTIVE=1`、代理指向 `127.0.0.1:9`、npm/pip/cargo offline 标记、ssh 桩），不是内核强制：绕过代理的原始 socket 仍可联网。内核级禁网（WFP 按沙盒账户 SID）只有 Codex 的 elevated 档才有，本插件不实现。macOS/Linux 的禁网是内核级的（Seatbelt deny-default / 空 network namespace）。
- **Windows 会在工作区根写入持久 ACE**（授予随机 capability SID 写权限），卸载插件后如需清理，可删除目录 ACL 中对应 `S-1-5-21-…` 未知账户条目，或参考 Codex 的卸载逻辑。
- Linux 纯 bwrap 不套 seccomp：AF_INET 在空 netns 中本就不通，但路径型 AF_UNIX socket（docker.sock、dbus 等）经全盘只读绑定仍可达；WSL2 已遮蔽 `/run/WSL` interop 逃逸口，AF_VSOCK 残余风险与 Codex 经典版一致。WSL1 无 user namespace，直接拒绝。
- macOS 移植为最小可用版：保留 base/read/write/network/preferences 段与锚点 deny、fcntl deny；未移植 deny-read glob、代理网络、seatbelt daemon 保护（全盘读模型下不需要）。
- 沙盒内命令失败（`operation not permitted` / `permission denied` / `read-only file system` 等）通常意味着策略限制，可调整 `writableRoots` 或临时设 `policy: "danger-full-access"`。

## 开发

```sh
npm install
npm test          # 34 个单元测试（node --test，Node 原生 TS 剥离）
npm run typecheck
npm run live:windows   # Windows 实测：优先用本机构建的 launcher，否则 codex.exe，验证读写/禁网标记
```

## 许可证与归属

本项目以 **Apache-2.0** 发布（见 [LICENSE](./LICENSE)）。它包含并移植自 [OpenAI Codex](https://github.com/openai/codex)（Apache-2.0）的代码，并随附 WezTerm、path-absolutize 的 MIT 代码；完整归属声明与全文见 [NOTICE](./NOTICE)。

- `rust/vendor/` 由 `scripts/sync-rust.ts` 从上游 Codex 逐字生成（crate 闭包），仅重写 Cargo manifest 以组成独立 workspace；
- `src/` 中的 macOS Seatbelt profile 与 Linux bubblewrap 调用为 Codex 源码的 TypeScript 移植。