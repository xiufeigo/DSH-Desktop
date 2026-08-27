> **声明**：本项目由 DeepSeek Harness（deepseek-hardness）配合 DeepSeek-V4-Pro 模型以 VibeCoding 方式制作而成。

# DSH Desktop

第三方开发的 DeepSeek Harness（`dsh`）桌面版：GUI 由安装程序一键部署（Windows），CLI 是免安装单二进制（Windows/Linux）。无论哪种，用户都不需要安装 Node.js、pnpm 或任何运行时。

- **GUI（Windows）**：Tauri v2 + 系统 WebView2，内嵌 dsh 自带 Web GUI，设置/API key/会话与 CLI 共享。
- **CLI（Windows + Linux）**：**单二进制**启动器——Node 运行时和 dsh 载荷压缩后追加在二进制尾部，首次运行自动解压到用户缓存目录，之后每次秒开；无任何外部依赖（不依赖 WebView2、不依赖 webkit2gtk、不需要 FUSE）。
- GUI 与 CLI 共享 `$DSH_HOME`：同一套 API key、会话历史与 profile。

## 用法

```
# Windows：桌面版安装程序
DSH-Desktop-Setup-<ver>.exe     # NSIS 安装：快捷方式 + 卸载器；系统缺 WebView2 时启动会弹窗引导安装

# Windows / Linux：CLI 单二进制（下载即用，无需安装）
dsh-cli-<ver>-win-x64.exe       # 直接运行 dsh 原生命令行（--version / --profile tui / web ...）
dsh-cli-<ver>-linux-x64         # chmod +x 后即可运行
```

## 网络代理（仅对 DSH 生效，GUI 热生效）

DSH 本体是纯 Node 进程：既不读 Windows"系统代理"（注册表），全局 `fetch` 默认也不理会 `HTTP_PROXY`/`HTTPS_PROXY`（Node ≥24 需要 `NODE_USE_ENV_PROXY=1` 才启用）；而它的 `.env` 加载器把这几个代理变量列为 bootstrap-only、只认**启动方注入的环境**。因此桌面版把代理做成 wrapper 自己的设置：

- **GUI**：设置 → 通用设置 → **桌面 → 网络代理**。填地址（如 `http://127.0.0.1:7897`）、勾选启用、点保存——**即时生效，无需重启**。
- **热生效原理**：GUI 启动时在本地起一个转发中继（127.0.0.1 随机端口），后端环境的代理地址固定指向中继；GUI 内部持有真实上游（Clash 地址或直连），保存即原子切换，新连接立刻走新出口。后端、插件、session、工具调用全部无感跟随。
- **CLI**：单次启动型进程，每次运行读取最新配置并直接注入真实代理地址（天然就是新配置），与 GUI 共享同一份 settings.json。
- **作用范围**：环境变量只注入 dsh 进程树，**不写用户/系统全局环境变量，不影响其它程序**。
- **实际注入**：`HTTP_PROXY` / `http_proxy` / `HTTPS_PROXY` / `https_proxy` / `NO_PROXY` / `no_proxy` / `NODE_USE_ENV_PROXY=1`。直连例外留空时默认 `localhost,127.0.0.1,::1`。
- **配置文件**（GUI 与 CLI 共享，可手改）：
  - Windows：`%APPDATA%\dsh-desktop\settings.json`
  - Linux（CLI）：`$XDG_CONFIG_HOME/dsh-desktop/settings.json`（默认 `~/.config/...`）
  - 格式：`{"proxy":{"enabled":true,"url":"http://127.0.0.1:7897","noProxy":""}}`
- 只接受 `http://` / `https://` 代理（HTTP CONNECT 隧道；Clash/v2rayN 等的混合端口直接可用）。文件损坏或字段缺失按"未启用"处理，不会阻塞启动。中继不可用时自动退回静态注入的老行为。

## 会话通知与提示音（GUI）

窗口在后台也能掌握回合状态。设置 → 通用设置 → **桌面**，语义对齐 [opencode](https://github.com/anomalyco/opencode)：

- **系统通知**：三个独立开关
  - 智能体——回合完成时弹系统通知（默认开）
  - 权限——需要审批或需要你回答时弹系统通知（默认开）
  - 错误——回合出错时弹系统通知（默认关）
- **音效**：同样的三个通道各配一个提示音，共 45 种内置音效（取自 opencode，MIT，见 `crates/dsh-gui/audio/README.md`）。下拉选择即试听，选「无」关闭该通道；默认与 opencode 一致（Staplebops 01 / Staplebops 02 / Nope 03）。
- 窗口在前台时不重复弹通知卡片（任务栏闪烁照常），提示音则按各自开关独立触发；WebView2 自动播放已由启动参数放行。
- 通知观察**按会话划分**：切走正在生成的会话不会被误判成「回合完成」而误报；审批/提问卡按会话记忆去重——切回不重发，出现新卡才再次提醒；错误卡只在同一会话内有新增时触发。
- 偏好保存在 WebView 的 cookie + localStorage（`dsh_gui_notify_v2` JSON）；旧版单开关 `dsh_gui_notify_v1` 关闭过的用户迁移后默认全关。

## 原理

DSH 本体基于 Node.js 并已发布到 npm（原生模块均带预编译产物，用户无需编译）。桌面版把它"装箱"：

```
GUI（Windows）                     CLI（Windows / Linux）
┌─ Tauri 壳（Rust，约 8 MB）────┐     ┌─ Rust 启动器（几百 KB）────────────┐
│  起内置 dsh web → 开窗口    │     │  首启解压内置载荷到缓存 → exec node  │
└────────────────────────────┘     └─ 载荷：zstd 压缩后追加在二进制尾部 ──┘
                 共享载荷：精简 Node 官方运行时 + @deepseek-ai/dsh 依赖闭包
                 + dsh-web-app 解析出的兼容 Web 前端
```

- CLI 二进制布局：`[启动器代码][tar.zst 载荷][footer(魔数+偏移+sha256)]`；首启校验哈希后解压到 `%LOCALAPPDATA%\dsh-cli\<hash>`（Windows）或 `~/.cache/dsh-cli/<hash>`（Linux），以内容哈希为键，升级后自动换新缓存目录。
- GUI 安装布局：`payload/{node,app,THIRD_PARTY_NOTICES.txt,LICENSE}` 随 NSIS 安装到应用目录，启动时由 Tauri 壳拉起 dsh web 并打开 WebView2 窗口。
- 载荷基于 **pin 死的 npm 发布版**：只有 dsh 作为应用的直接生产依赖；Web 前端版本由 `dsh-web-app` 决定。打包时按 `npm ls` 复制生产闭包，只保留 Node 可执行文件与许可证，并剔除类型声明、source map、PDB、测试目录和非目标架构的 `node-pty` 预编译产物。
- dsh 是 developer preview，接口会变：每个 DSH Desktop 版本对应一个固定的 dsh 版本。

## 同步上游（DeepSeek Harness 更新）

载荷版本只有一个事实来源：`package.json` 的 `@deepseek-ai/dsh` 直接依赖。`@deepseek-ai/dsh-web-frontend` 不直接 pin，由 `dsh-web-app` 选择兼容版本；同步脚本和 CI 会验证依赖树中只有这一套前端。

- **手动（一条命令）**：`node scripts/update-dsh.mjs` — 自动查 npm 最新版、精确 pin、重装、验证闭包并冒烟 `dsh --version`；随后本地出包，或直接推 `v*` tag 让 CI 出全平台产物。
- **版本规则与打包闸门**：桌面版号 = 官方 dsh 版本 + 本地打包后缀（官方 `0.1.0-rc.7` → 桌面 `0.1.0-rc.7.1`）。每个 `pack-cli` / `pack-gui` 步骤开头都会跑 `scripts/sync-and-bump.mjs`：先查上游、有新版则同步载荷，再递增打包后缀；`--skip-sync` / `--skip-bump` 可分别跳过两步。
- **发布即 tag**：CI 的三个打包步骤均带 `--skip-sync --skip-bump`——tag 提交就是版本的唯一事实来源，产物名与 tag 严格一致（此前曾在 CI 内被连 bump 两次导致产物版本漂移）；上游更新只走每周 `update.yml` 的 PR 流程。
- **自动**：`.github/workflows/update.yml` 每周一检查上游，有新版自动开 PR；PR 必须通过 Windows/Linux 的依赖树、payload、CLI、Web 和原生模块冒烟后才能合并。
- dsh 是 developer preview，跨版本可能有破坏性变更；不要绕过同步 PR 的冒烟检查。

### deepseek-harness 源码补丁（patches/）

个别优化以上游源码补丁的形式维护在本仓库，每次同步/升级 deepseek-harness 之后重放一次即可（幂等）：

```sh
npm run harness:patch                 # 实际应用全部补丁
pwsh scripts/apply-patches.ps1 -Check # 只看会做什么，不改文件
```

| 补丁 | 说明 |
| --- | --- |
| `deepseek-harness-markdown-settled-cache.patch` | 给 `MarkdownText` 的 settled 渲染加 40 条 LRU 缓存：切回超长会话时已完成消息不再整批重新解析 GFM/KaTeX |

- 补丁插入点极小、上下文锚定明确，跨版本大概率直接合上；合不上时脚本会用 `--3way` 兜底，仍失败则落 `.reject` 文件，人工手贴那几行后提交。
- **本地立即生效链路**（免等上游发版）：补丁进检出后本地重建前端并注入载荷预编译 dist：

  ```sh
  pwsh scripts/apply-patches.ps1        # 1) 补丁合入 deepseek-harness 检出（幂等）
  # 2) 在 harness 检出里重建：pnpm run build:lib:client && pnpm run build:web
  npm run harness:frontend              # 3) 注入仓库 node_modules 与已安装 GUI 的 dist
  ```

  注入脚本先扫描新产物 sourcemap、确认包含补丁标记（`renderSettledCached`）才落盘；首次注入自动把上游原版备份为同级 `dist.upstream-bak`。重启 DSH shell 生效；`node scripts/inject-local-frontend.mjs --restore` 一键回到上游版本，`--status` 查看各处指纹。注入版自带 sourcemap 便于 DevTools 定位——打安装器时 prepare-payload 会按既有规则剔除 .map，不影响发布体积契约。

- **出包已自动携带**：`pack-cli` / `pack-gui` 在 `npm ci` 之后、生产闭包复制之前会跑 `scripts/ensure-local-frontend.mjs` 重放上面的注入（幂等），所以只要本机补丁+检出+构建产物齐备，正常打包命令无需任何额外动作；本机没有检出时（如 GitHub runner）自动警告放行官方前端，显式跳过传 `--skip-local-frontend`。

## 构建

```sh
npm ci

node scripts/pack-cli.mjs            # 当前平台 CLI 单二进制 → dist/dsh-cli-<ver>-<plat>-x64(.exe)
node scripts/pack-cli.mjs --linux    # Linux CLI（必须在 Linux 上跑）
node scripts/pack-gui.mjs            # Windows GUI 安装程序 → dist/DSH-Desktop-Setup-<ver>.exe
```

需要 Rust 工具链（stable）；NSIS 由 tauri-bundler 自动获取。构建步骤由 `pack-cli.mjs` / `pack-gui.mjs` 编排：`sync-and-bump.mjs` 打包前闸门（本地默认查上游并递增后缀；CI 发布传 `--skip-sync --skip-bump`）→ `npm ci` → `ensure-local-frontend.mjs` 补丁前端闸门（仓库维护 `patches/` 且本机有 deepseek-harness 检出构建产物时，自动把打补丁的前端重新注入刚被 npm ci 还原的官方载荷；无检出环境如 CI 自动放行官方流）→ `prepare-payload.mjs`（Node 运行时 + 生产闭包 + 瘦身 + 许可证材料）→ cargo 构建 → 载荷追加 / tauri-bundler NSIS。CI 已按原生矩阵排好：推 tag `v*` 或手动触发 `.github/workflows/release.yml`，自动产出 Windows GUI 安装程序 + CLI exe、Linux CLI 单二进制并挂到 Release。

## 已知行为与限制

- **CLI 首次运行**：需要把载荷解压到缓存目录（当前 Windows 载荷约 193 MiB、约 1.3 万个文件；Linux 约 233 MiB——sharp/node-pty/koffi 等原生模块需同时带 glibc 与 musl 变体），Windows Defender 会扫描这些文件；仅首次解压发生。删除缓存目录不影响功能，下次运行会重新解压。打包契约对载荷设了 **256 MiB / 15000 文件**上限，超限即构建失败，防体积失控。
- **GUI 依赖系统 WebView2**：Win10/11 家用版自带；LTSC/Server/精简版可能没有，启动时会弹窗给出下载地址，装好后即可用。
- **SmartScreen**：v1 尚未做代码签名，首次运行安装程序/二进制时 Windows 可能提示"仍要运行"，点"更多信息 → 仍要运行"放行即可；代码签名已列入后续计划。
- **自动更新**：v1 暂未内置；升级即替换文件（`$DSH_HOME` 数据不受影响）。
- **日志**：GUI 模式后端日志在 `%APPDATA%/dsh-desktop/logs/dsh-web.log`。设置 `DSH_STARTUP_TRACE=1` 后，启动阶段耗时写入同目录的 `startup-trace.jsonl`；默认不创建 trace。

## 目录

```
crates/dsh-cli/                   CLI 单二进制启动器（自解压 + exec node + 载荷追加打包器；proxy.rs 注入代理环境）
crates/dsh-gui/                   GUI Tauri v2 壳（spawn dsh web + WebView2 窗口 + 单实例 + 缺失提示；settings.rs 代理偏好 + 设置面板注入）
scripts/prepare-payload.mjs       载荷准备：生产闭包复制 + 瘦身 + 许可证材料
scripts/verify-payload.mjs        载荷契约、Node/CLI/Web/node-pty 冒烟
scripts/pack-cli.mjs / pack-gui.mjs  打包编排
scripts/collect-notices.mjs       许可证审计：生成载荷内 THIRD_PARTY_NOTICES.txt（含 LGPL 补充）
scripts/collect-rust-licenses.mjs  Rust 依赖审计：生成 build/rust-licenses.txt（486 crate + 许可证全文）
scripts/update-dsh.mjs            上游同步：一键升级 dsh 载荷并验证
scripts/sync-and-bump.mjs         打包前闸门：查上游→按需同步→递增桌面包后缀（--skip-sync/--skip-bump）
scripts/apply-patches.ps1         补丁重放：升级 harness 后把 patches/ 合入其源码检出（幂等，-Check 试运行）
scripts/inject-local-frontend.mjs 本地前端注入：sourcemap 校验 + 自动备份/回滚，覆盖 repo 与已安装 GUI 的 dist
scripts/ensure-local-frontend.mjs 打包含丁前端闸门：npm ci 后自动重注入补丁版前端（CI 无检出时放行官方流）
patches/deepseek-harness-markdown-settled-cache.patch  本地源码补丁：会话消息 settled 渲染 LRU 缓存（性能）
scripts/desktop-version.mjs       桌面版号规则：官方 dsh 版本 + 本地打包后缀
scripts/config.mjs                共享打包配置：APP_ID / VERSION 常量、Node 渠道与镜像源
scripts/payload-contract.mjs      载荷契约：256 MiB / 15000 文件上限等常量（配套 .test.mjs，npm test）
scripts/benchmark-windows.ps1     Windows 安装程序启动基准测试
scripts/fetch-node.mjs            Node 运行时下载
scripts/make-icons.mjs            从 DeepSeek SVG 生成多尺寸应用图标
scripts/make-audio.mjs            把 crates/dsh-gui/audio 的提示音内嵌为 src/audio.js（data URI）
.github/workflows/release.yml     全平台构建与发布（Windows：GUI + CLI；Linux：CLI）
.github/workflows/ci.yml          上游同步 PR 的 Windows/Linux 兼容性门禁
.github/workflows/update.yml      每周自动同步上游（开 PR）
```

## 许可证与合规

- **本项目代码**：MIT（仓库 `LICENSE`）。**内置 DeepSeek Harness**：MIT（Copyright DeepSeek）；Web 前端 `@deepseek-ai/dsh-web-frontend` 为 BSD-3-Clause——均为宽松许可证。
- **载荷依赖树已程序化审计**（`scripts/collect-notices.mjs`，构建时自动生成随产物分发的 `THIRD_PARTY_NOTICES.txt`）：当前生产闭包共 523 个包；各包的许可证声明与随包许可证文本会写入产物。
- **唯一的弱 copyleft 例外**：`@img/sharp-win32-x64`（经 sharp → dsh-attachment-local 引入，用于附件图片处理）声明 `Apache-2.0 AND LGPL-3.0-or-later`——sharp 本体为 Apache-2.0，其内置的 libvips 为 LGPL-2.1-or-later，以**独立 DLL 动态链接、未作修改随包分发**，符合 LGPL 再分发要求；该包自身只附 Apache 文本，`collect-notices.mjs` 会自动把 LGPL-3.0 全文（`build/licenses/LGPL-3.0.txt`）补进 THIRD_PARTY_NOTICES.txt。
- **运行时随附各自的许可证**：Node.js（`payload/node/LICENSE`）；GUI 的 WebView2 由 Microsoft 随系统提供，不随本包分发。
- **提示音素材**：45 个音效复制自 opencode（MIT，Copyright opencode），以 data URI 内嵌进 GUI 二进制，出处与许可见 `crates/dsh-gui/audio/README.md`。
- **Rust 依赖**：dsh-gui / dsh-cli 静态链接的 486 个 crate 已程序化审计（`scripts/collect-rust-licenses.mjs` → `build/rust-licenses.txt`，随产物分发）：全部为宽松许可证（MIT / Apache-2.0 / BSD-3-Clause / ISC / Zlib / Unicode-3.0），5 个 MPL-2.0（文件级弱 copyleft，未作修改、源码即 crates.io 原包）与 r-efi（三许可，本项目选择 MIT）；无 GPL/AGPL/EPL。
- **商标与命名**：DeepSeek 为 DeepSeek 公司的商标。本项目是基于其开源 Harness 的社区桌面封装，与官方无隶属关系；名称仅用于指代所基于的项目。产品名采用 DSH Desktop，以区别于官方 DeepSeek 品牌。
- 若发现许可证信息有遗漏或疑问，欢迎提 issue 指正。

## License

[MIT](LICENSE)。内置的 DeepSeek Harness 及其依赖遵循各自许可证（见产物内 THIRD_PARTY_NOTICES.txt）。
