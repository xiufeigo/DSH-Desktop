/**
 * 打包规则闸门（pack 流水线第 4 步）：确保载荷里的 Web 前端反映本仓库维护的
 * harness 源码补丁。
 *
 * 背景：pack-cli / pack-gui 在打包开头跑 `npm ci`，会把 node_modules 还原成
 * 官方 pin 版本——此前手工注入的补丁版前端会被冲掉。因此打包编排必须在
 * `npm ci` 之后、`prepare-payload`（生产闭包复制）之前调用这里，把本地构建的
 * 补丁版前端重新注入仓库载荷。完整链路见 README「deepseek-harness 源码补丁」：
 *   apply-patches.ps1 → harness 里 pnpm run build:lib:client && build:web
 *   → （打包时自动）本脚本 → inject-local-frontend.mjs --only repo
 *
 * 决策树（CI 安全：GitHub runner 上没有 sibling 检出时放行官方流并给出警告）：
 *   patches/*.patch 为空                         → 通过（无源码补丁的纯官方流）
 *   无 deepseek-harness 检出 / 其 apps/web/dist   → 警告通过（按官方前端打包，
 *     并提示如何启用本地链路）
 *   本地构建 sourcemap 不含 renderSettledCached   → 失败退出（产物可疑，宁可
 *      出错也不静默打进安装器）
 *   校验通过                                     → 幂等执行
 *      inject-local-frontend.mjs --only repo，随后对仓库 dist 复核标记
 *
 * 用法：
 *   node scripts/ensure-local-frontend.mjs               # 正常闸门
 *   node scripts/ensure-local-frontend.mjs --skip        # 显式跳过（等价 pack 的 --skip-local-frontend）
 *   --harness <dir>    指定检出（默认 ../deepseek-harness 或 $DSH_HARNESS_PATH）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)

const fail = (message) => {
  console.error(`ensure-local-frontend: ${message}`)
  process.exit(1)
}

if (argv.includes('--skip') || argv.includes('--skip-local-frontend')) {
  console.log('ensure-local-frontend: --skip 指定，跳过本地补丁前端闸门')
  process.exit(0)
}

/** 收集 patches/ 下的补丁清单；空数组代表纯官方流。 */
function listPatches() {
  try {
    return readdirSync(join(root, 'patches')).filter((name) => name.endsWith('.patch')).sort()
  } catch {
    return []
  }
}

/** sourcemap 标记扫描：判据与 inject-local-frontend.mjs 保持一致。 */
function scanMarker(distDir) {
  let maps = 0
  const recurse = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const hit = recurse(full)
        if (hit) return hit
      } else if (entry.name.endsWith('.map')) {
        maps += 1
        let map
        try { map = JSON.parse(readFileSync(full, 'utf8')) } catch { continue }
        const text = `${map.sources?.join('\n') ?? ''}\n${(map.sourcesContent ?? []).join('\n')}`
        if (text.includes('renderSettledCached') || text.includes('SETTLED_CACHE_LIMIT')) return full
      }
    }
    return null
  }
  return { hit: recurse(distDir), maps }
}

// ---- 主流程 -------------------------------------------------------------------

const patches = listPatches()
if (patches.length === 0) {
  console.log('ensure-local-frontend: patches/ 为空，按官方前端打包')
  process.exit(0)
}

const harnessDir = argv.includes('--harness')
  ? resolve(argv[argv.indexOf('--harness') + 1])
  : process.env.DSH_HARNESS_PATH ? resolve(process.env.DSH_HARNESS_PATH) : resolve(root, '..', 'deepseek-harness')
const localDist = join(harnessDir, 'apps', 'web', 'dist')

if (!existsSync(join(localDist, 'index.html'))) {
  console.warn(`ensure-local-frontend: [warn] 未找到本地补丁前端构建（${localDist}），本包按官方前端发布。`)
  console.warn('                       如需携带源码补丁：在 harness 检出先跑 `pnpm install && pnpm run build:lib:host && pnpm run build:lib:client && pnpm run build:web` 再打包。')
  process.exit(0)
}

const marker = scanMarker(localDist)
if (!marker.hit) {
  fail(`本地构建 ${localDist} 的 sourcemap 不含补丁标记 renderSettledCached（扫描了 ${marker.maps} 个 map）。` +
    '请重跑 pnpm run build:lib:host && pnpm run build:lib:client && pnpm run build:web；确要忽略请用 pack 的 --skip-local-frontend。')
}
console.log(`ensure-local-frontend: 补丁标记校验通过 —— ${marker.hit}`)

// 版本闸门：补丁前端必须与载荷 pin 的官方版本同源。只校验补丁标记是不够的
// ——上一版检出构建出的 dist 同样带标记，却会与新版后端对不上（客户端启动图
// 与 RPC 面都可能已变），那会静默打出错配载荷。
const harnessFrontend = join(harnessDir, 'apps', 'web', 'package.json')
if (!existsSync(harnessFrontend)) {
  fail(`版本闸门失败：找不到 ${harnessFrontend}，无法确认本地构建的版本。`)
}
const buildVersion = JSON.parse(readFileSync(harnessFrontend, 'utf8')).version
const pinnedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
if (buildVersion !== pinnedVersion) {
  fail(
    `版本闸门失败：本地构建的补丁前端是 ${buildVersion}，载荷 pin 的是 ${pinnedVersion}。` +
    `请在 harness 检出切到 dsh-v${pinnedVersion} 后重跑 ` +
    '`pnpm install && pnpm run build:lib:host && pnpm run build:lib:client && pnpm run build:web`；' +
    '确要按官方前端出包请传 pack 的 --skip-local-frontend。',
  )
}
console.log(`ensure-local-frontend: 前端版本与载荷一致 —— ${pinnedVersion}`)

console.log(`ensure-local-frontend: 注入仓库载荷前端（幂等）… 源补丁: ${patches.join(', ')}`)
const injected = spawnSync(process.execPath, [join(root, 'scripts', 'inject-local-frontend.mjs'), '--only', 'repo'], {
  cwd: root,
  stdio: 'inherit',
})
if (injected.error !== undefined) throw injected.error
if (injected.status !== 0) {
  fail(`注入失败（exit ${String(injected.status)}）；如需按官方前端出包，改用 --skip-local-frontend。`)
}

// 复核：注入后的仓库载荷 dist 必须能扫到同一标记。
const repoDist = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
if (!existsSync(repoDist)) fail(`注入复核失败：找不到 ${repoDist}`)
const after = scanMarker(repoDist)
if (!after.hit) fail(`注入复核失败：${repoDist} 的 sourcemap 仍无补丁标记`)
console.log(`ensure-local-frontend: 通过 —— 本次打包载荷将携带打补丁的前端（标记位于 ${after.hit.replace(repoDist, '')}）`)
