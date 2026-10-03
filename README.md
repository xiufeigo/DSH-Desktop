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

## 后端运行环境（GUI：Windows 原生 vs WSL2）

默认用捆绑的 Windows 原生运行时（node.exe + dsh 闭包）直接在本机起后端。设置 → 通用设置 → **桌面 → 后端运行环境** 可切成 **WSL2**：

- **切换**：下拉选 WSL2 → 保存 → 确认重启后端（会中断当前会话）。后端改在所选发行版内运行，经 WSL2 默认 `localhostForwarding` 把发行版内 `127.0.0.1` 端口桥接到本机，WebView/就绪探测无需任何改动。
- **载荷来源**：优先使用**随安装包携带的 Linux 载荷**（`payload/payload-linux/`，由 Linux/CI 构建时产出）；首次切到 WSL 时自动经 `tar` 管道部署进发行版并按指纹幂等（载荷变了才重部署）。安装包未带 Linux 载荷时（Windows 机器上无法装配——`sharp`/`koffi`/`node-pty` 只有 win32 变体被 `npm ci` 安装），回退为使用发行版内**已装好的 `dsh`**。
- **进程生命周期**：dsh 在发行版内前台运行，`wsl.exe` 只当中继外壳；关闭/重启时用 pidfile + `kill` 精确回收真实进程，避免孤儿。
- **数据隔离（MVP）**：WSL 后端用 Linux 侧的独立 `$DSH_HOME`，API Key/会话与 Windows 后端相互独立，需要时在 WSL 里单独配置。
- **代理与 WSL**：WSL2 的 VM 到不了 Windows 回环地址，因此代理地址填成本机回环（如 `http://127.0.0.1:7897`）时，WSL 后端按「未启用代理」启动（注入了也只会指向一个死端口）；填局域网可达地址则照常注入生效。

## 网络代理（仅对 DSH 生效）

代理能力由 **dsh 本体**提供：`@deepseek-ai/dsh-http-proxy` 从 dsh 0.1.5 起解析启动环境（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，大小写皆可）并把结果装成 undici 的全局 dispatcher——模型请求、web 搜索、`web_fetch`、走 HTTP 的 MCP、派生子进程一并覆盖；loopback 永久直连，被拒的 scheme（如 SOCKS）保持直连并在 stderr 报告，且**不读操作系统"系统代理"**。桌面版只做一件事：**把你填的偏好作为启动环境交给 dsh**。

- **GUI**：设置 → 通用设置 → **桌面 → 网络代理**。填地址（如 `http://127.0.0.1:7897`）、勾选启用、点保存。dsh 的代理策略在每个进程 boot 时解析一次，因此**保存后需重启后端生效**；需要时面板会出现「立即重启后端」按钮（会中断当前会话）。
- **CLI**：单次启动型进程，每次运行都读取最新配置并注入，天然即时生效；与 GUI 共享同一份 settings.json。
- **作用范围**：注入前先清掉继承来的同名变量，让保存的偏好（或「直连」）成为唯一事实来源；只作用于 dsh 进程树（插件 / session / 工具调用），**不写用户/系统全局环境变量，不影响其它程序**。
- **实际注入**：`HTTP_PROXY` / `http_proxy` / `HTTPS_PROXY` / `https_proxy` / `NO_PROXY` / `no_proxy`。直连例外留空时默认 `localhost,127.0.0.1,::1`。`NODE_USE_ENV_PROXY` 不再由 wrapper 代管——那是 dsh 自己的策略在派生子进程时决定的事。
- **配置文件**（GUI 与 CLI 共享，可手改）：
  - Windows：`%APPDATA%\dsh-desktop\settings.json`
  - Linux（CLI）：`$XDG_CONFIG_HOME/dsh-desktop/settings.json`（默认 `~/.config/...`）
  - 格式：`{"proxy":{"enabled":true,"url":"http://127.0.0.1:7897","noProxy":""},"backend":{"mode":"native"|"wsl","distro":"Ubuntu","deployDir":"~/.local/share/dsh-desktop/backend"}}`
- 只接受 `http://` / `https://` 代理（HTTP CONNECT 隧道；Clash/v2rayN 等的混合端口直接可用）。文件损坏或字段缺失按「未启用」处理，不会阻塞启动。
- 也可以把代理写进 `$DSH_HOME/.env`：dsh 对这四个名字在该文件里开了豁免，效果与桌面版设置一致（两种方式都设时以 dsh 自身的层叠规则为准）。

## 会话通知与提示音（GUI）

窗口在后台也能掌握回合状态。设置 → 通用设置 → **桌面**，语义对齐 [opencode](https://github.com/anomalyco/opencode)：

- **系统通知**：三个独立开关
  - 智能体——回合完成时弹系统通知（默认开）
  - 权限——需要审批或需要你回答时弹系统通知（默认开）
  - 错误——回合出错时弹系统通知（默认关）
- **音效**：同样的三个通道各配一个提示音，共 45 种内置音效（取自 opencode，MIT，见 `crates/dsh-gui/audio/README.md`）。下拉选择即试听，选「无」关闭该通道；默认与 opencode 一致（Staplebops 01 / Staplebops 02 / Nope 03）。
- 窗口在前台时不重复弹通知卡片（任务栏闪烁照常），提示音则按各自开关独立触发；WebView2 自动播放已由启动参数放行。
- 通知观察**按会话划分**：切走正在生成的会话不会被误判成「回合完成」而误报；审批/提问卡按会话记忆去重——切回不重发，出现新卡才再次提醒；错误卡只在同一会话内有新增时触发。
- **退出登录不算错误**：dsh 0.2.0 起「因退出 DeepSeek 登录而停止的任务」复用错误卡样式（`turnErrorTitle`）；桌面版按卡片上的 `code`（`ACCOUNT_SIGNED_OUT`）区分，不计入错误通道，避免主动退出登录时误报错误。
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

- **手动（一条命令）**：`node scripts/update-dsh.mjs` — 自动查 npm 最新版、精确 pin、重装、验证闭包并冒烟 `dsh --version`；随后本地出包，或直接推 `v*` tag 让 CI 出全平台产物。同步是**只升不降**的：pin 领先于 npm `latest`（如提前采纳 `alpha` 预发布）时保留 pin、跳过同步，CI 周任务不会把预发布 pin 拉回旧 stable。
- **版本规则与打包闸门**：桌面版号 = 官方 dsh 版本 + 本地打包后缀（官方 `0.1.0-rc.7` → 桌面 `0.1.0-rc.7.1`）。每个 `pack-cli` / `pack-gui` 步骤开头都会跑 `scripts/sync-and-bump.mjs`：先查上游、有新版则同步载荷，再递增打包后缀；`--skip-sync` / `--skip-bump` 可分别跳过两步。
- **发布即 tag**：CI 的三个打包步骤均带 `--skip-sync --skip-bump`——tag 提交就是版本的唯一事实来源，产物名与 tag 严格一致（此前曾在 CI 内被连 bump 两次导致产物版本漂移）；上游更新只走每周 `update.yml` 的 PR 流程。
- **自动**：`.github/workflows/update.yml` 每周一检查上游，有新版自动开 PR；PR 必须通过 Windows/Linux 的依赖树、payload、CLI、Web 和原生模块冒烟后才能合并。
- dsh 是 developer preview，跨版本可能有破坏性变更；不要绕过同步 PR 的冒烟检查。

### 前端与上游源码

本仓库不再维护任何针对 deepseek-harness 源码的本地补丁，也没有补丁应用/前端注入链路。Web 前端直接使用 npm 官方发布的 `@deepseek-ai/dsh-web-frontend`（版本由 `dsh-web-app` 解析，见上方「同步上游」）；打包流程不重建、不注入、不覆盖官方 `dist`，`npm ci` 之后复制进生产闭包的就是官方前端。

## 构建

```sh
npm ci

node scripts/pack-cli.mjs            # 当前平台 CLI 单二进制 → dist/dsh-cli-<ver>-<plat>-x64(.exe)
node scripts/pack-cli.mjs --linux    # Linux CLI（必须在 Linux 上跑）
node scripts/pack-gui.mjs            # Windows GUI 安装程序 → dist/DSH-Desktop-Setup-<ver>.exe
```

需要 Rust 工具链（stable）；NSIS 由 tauri-bundler 自动获取。构建步骤由 `pack-cli.mjs` / `pack-gui.mjs` 编排：`sync-and-bump.mjs` 打包前闸门（本地默认查上游并递增后缀；CI 发布传 `--skip-sync --skip-bump`）→ `npm ci` → `prepare-payload.mjs`（Node 运行时 + 生产闭包 + 瘦身 + 许可证材料）→ cargo 构建 → 载荷追加 / tauri-bundler NSIS。CI 已按原生矩阵排好：推 tag `v*` 或手动触发 `.github/workflows/release.yml`，自动产出 Windows GUI 安装程序 + CLI exe、Linux CLI 单二进制并挂到 Release。

## 已知行为与限制

- **CLI 首次运行**：需要把载荷解压到缓存目录（dsh 0.2.0 起 Windows 载荷约 434 MiB、约 1.24 万个文件，其中官方 Office 转换器 `libreoffice-kit.exe` 单文件就 170 MiB；Linux 载荷更大——sharp/node-pty/koffi 等原生模块需同时带 glibc 与 musl 变体），Windows Defender 会扫描这些文件；仅首次解压发生。删除缓存目录不影响功能，下次运行会重新解压。载荷变大直接反映在产物上（0.1.5 的 CLI exe 为 52.8 MiB、安装器 45.4 MiB；该 170 MiB 的 exe 实测 zstd 压缩比约 2.65）。打包契约对载荷设了 **512 MiB / 15000 文件**上限，超限即构建失败，防体积失控。
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
scripts/desktop-version.mjs       桌面版号规则：官方 dsh 版本 + 本地打包后缀
scripts/config.mjs                共享打包配置：APP_ID / VERSION 常量、Node 渠道与镜像源
scripts/payload-contract.mjs      载荷契约：512 MiB / 15000 文件上限等常量（配套 .test.mjs，npm test）
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
