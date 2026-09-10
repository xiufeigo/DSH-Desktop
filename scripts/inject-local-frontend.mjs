/**
 * 把本地构建的 dsh-web-frontend 注入载荷里的预编译 dist。
 *
 * 完整链路（见 README「deepseek-harness 源码补丁」）：
 *   1. pwsh scripts/apply-patches.ps1          # 补丁进 harness 源码检出
 *   2. harness 仓库里 pnpm run build:lib:client && pnpm run build:web
 *   3. node scripts/inject-local-frontend.mjs   # 本脚本：校验新产物并覆盖两处 dist
 *   4. 重启 DSH shell 生效
 *
 * 两处注入目标：
 *   repo —— <本仓库>/node_modules/@deepseek-ai/dsh-web-frontend/dist
 *           （prepare-payload 的生产闭包从这里复制，决定以后打包出的 GUI/CLI 载荷）
 *   gui  —— %LOCALAPPDATA%\DSH Desktop\payload\app\node_modules\.../dist
 *           （当前已安装 GUI 实际加载的前端；路径不存在时自动跳过）
 *
 * 安全网：
 *   - 首次注入前把上游原版 dist 备份为同级 dist.upstream-bak（此后永不覆盖该备份）；
 *   - 注入前扫描本地构建的 sourcemap 确认包含补丁标记 renderSettledCached，
 *     找不到即拒绝注入（--allow-unverified 可越过）；
 *   - 注入前比对检出 `apps/web/package.json` 的版本与载荷 pin 的 dsh 版本：
 *     只认标记会放过"上一版检出构建的 dist"，那正是后端/前端错配的来源
 *     （--allow-version-mismatch 可越过）；
 *   - 注入幂等：目标与本地产物指纹一致时跳过。
 *
 * 用法：
 *   node scripts/inject-local-frontend.mjs              # 校验 + 注入全部可达目标
 *   node scripts/inject-local-frontend.mjs --status     # 只打印各处指纹与验证结果
 *   node scripts/inject-local-frontend.mjs --restore    # 从备份回滚为上游 dist
 *   --only repo|gui       只处理其中一个目标
 *   --allow-unverified    sourcemap 标记校验失败时仍允许注入（排查用）
 *   --allow-version-mismatch  构建版本与载荷 pin 不一致时仍允许注入（排查用）
 *   --harness <dir>       指定 deepseek-harness 检出（默认 ../deepseek-harness 或 $DSH_HARNESS_PATH）
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined

const harness = (() => {
  const explicit = args.includes('--harness')
    ? resolve(args[args.indexOf('--harness') + 1])
    : process.env.DSH_HARNESS_PATH ? resolve(process.env.DSH_HARNESS_PATH) : undefined
  const guess = resolve(repoRoot, '..', 'deepseek-harness')
  const dir = explicit ?? guess
  if (!existsSync(join(dir, 'apps', 'web', 'dist'))) {
    console.error(`[error] 没有找到本地前端构建产物：${join(dir, 'apps', 'web', 'dist')}（先在 harness 检出里跑 build）`)
    process.exit(2)
  }
  return dir
})()
const localDist = join(harness, 'apps', 'web', 'dist')

const targets = []
{
  const repoPkg = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
  if (existsSync(repoPkg)) targets.push({ id: 'repo', label: '仓库 node_modules', dist: join(repoPkg, 'dist') })
  const appData = process.env.LOCALAPPDATA
  if (appData) {
    const guiPkg = join(appData, 'DSH Desktop', 'payload', 'app', 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
    if (existsSync(guiPkg)) targets.push({ id: 'gui', label: '已安装 GUI 载荷', dist: join(guiPkg, 'dist') })
  }
}

/** 单个 dist 的聚合指纹：排序后的相对路径+内容哈希再总哈希。 */
function fingerprint(dir) {
  const h = createHash('sha256')
  let files = 0
  let bytes = 0
  let entry = null
  try {
    const indexHtml = readFileSync(join(dir, 'index.html'), 'utf8')
    entry = (/assets\/(index-[\w-]+\.js)/.exec(indexHtml))?.[1] ?? null
  } catch { /* 无 index.html 由调用方提示 */ }
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name
      const full = join(dir, childRel)
      if (statSync(full).isDirectory()) walk(childRel)
      else {
        files += 1
        bytes += statSync(full).size
        h.update(childRel); h.update('\0'); h.update(createHash('sha256').update(readFileSync(full)).digest()); h.update('\0')
      }
    }
  }
  walk('')
  return { digest: h.digest('hex').slice(0, 12), files, mib: (bytes / 1048576).toFixed(1), entry }
}

function describe(id, fp) {
  console.log(`  [${id}] ${fp ? `${fp.files} 文件 / ${fp.mib} MiB / 入口 ${fp.entry ?? '?'} / sha256:${fp.digest}` : '(不存在)'}`)
}

function describeInline(fp) {
  return `${fp.files} 文件 / ${fp.mib} MiB / 入口 ${fp.entry ?? '?'}`
}

/** 在 sourcemap 的 sourcesContent 里找补丁标记，证明产物确由打补丁源码编出。 */
function verifyPatchMarker() {
  let maps = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        const hit = walk(full)
        if (hit) return hit
      } else if (name.endsWith('.map')) {
        maps += 1
        const map = JSON.parse(readFileSync(full, 'utf8'))
        const text = `${map.sources?.join('\n') ?? ''}\n${(map.sourcesContent ?? []).join('\n')}`
        if (text.includes('renderSettledCached') || text.includes('SETTLED_CACHE_LIMIT')) return full
      }
    }
    return null
  }
  return { hit: walk(localDist), maps }
}

function filteredTargets(list) {
  return only ? list.filter((t) => t.id === only) : list
}

if (hasFlag('--status')) {
  console.log(`本地构建 (${relative(harness, localDist)}):`)
  describe('local', fingerprint(localDist))
  const v = verifyPatchMarker()
  console.log(`  补丁标记校验: ${v.hit ? `通过（${v.hit} 含 renderSettledCached）` : `未发现（扫描了 ${v.maps} 个 map）`}`)
  for (const t of targets) {
    console.log(`${t.label}:`)
    describe(t.id, existsSync(t.dist) ? fingerprint(t.dist) : null)
  }
  process.exit(0)
}

if (hasFlag('--restore')) {
  for (const t of filteredTargets(targets)) {
    const backup = join(dirname(t.dist), 'dist.upstream-bak')
    if (!existsSync(backup)) { console.log(`[${t.id}] 无备份可回滚，跳过`); continue }
    rmSync(t.dist, { recursive: true, force: true })
    cpSync(backup, t.dist, { recursive: true })
    console.log(`[${t.id}] 已回滚为上游备份（${describeInline(fingerprint(t.dist))}）`)
  }
  process.exit(0)
}

// ---- 主流程：校验 → 注入 -----------------------------------------------------

if (!existsSync(join(localDist, 'index.html'))) {
  console.error('[error] 本地构建产物缺 index.html，疑似未完成 build')
  process.exit(2)
}
const marker = verifyPatchMarker()
if (marker.hit) {
  console.log(`补丁标记校验: 通过 —— ${marker.hit}`)
} else if (hasFlag('--allow-unverified')) {
  console.warn('[warn] sourcemap 中未找到补丁标记，按 --allow-unverified 继续（产物可能不含 LRU 缓存改动！）')
} else {
  console.error('[error] 本地产物的 sourcemap 不含补丁标记 renderSettledCached —— 先确认补丁已应用且 build 完成，或加 --allow-unverified')
  process.exit(1)
}

// 版本闸门：标记相同不代表版本相同。上一版检出构建出的 dist 一样带标记，
// 注入进新版载荷就会得到"新后端 + 旧前端"的错配组合。
const buildVersion = JSON.parse(readFileSync(join(harness, 'apps', 'web', 'package.json'), 'utf8')).version
const pinnedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
if (buildVersion !== pinnedVersion) {
  if (!hasFlag('--allow-version-mismatch')) {
    console.error(
      `[error] 本地构建的补丁前端是 ${buildVersion}，载荷 pin 的是 ${pinnedVersion}：` +
      `注入会得到"新后端 + 旧前端"的错配组合。请在检出切到 dsh-v${pinnedVersion} 后重建，` +
      '或加 --allow-version-mismatch 强制注入。',
    )
    process.exit(1)
  }
  console.warn(`[warn] 版本不一致（构建 ${buildVersion} / pin ${pinnedVersion}），按 --allow-version-mismatch 继续`)
} else {
  console.log(`前端版本与载荷一致 —— ${pinnedVersion}`)
}

let changed = 0
for (const t of filteredTargets(targets)) {
  const before = existsSync(t.dist) ? fingerprint(t.dist) : null
  if (before && before.digest === fingerprint(localDist).digest) {
    console.log(`[${t.id}] 与本地产物一致，跳过`)
    continue
  }
  const backup = join(dirname(t.dist), 'dist.upstream-bak')
  if (!before) {
    console.log(`[${t.id}] 目标不存在，直接写入`)
  } else if (!existsSync(backup)) {
    cpSync(t.dist, backup, { recursive: true })
    console.log(`[${t.id}] 上游原版已备份 → dist.upstream-bak（${describeInline(before)}）`)
  } else {
    console.log(`[${t.id}] 已有备份保持不动（保证 --restore 永远回到上游）`)
  }
  rmSync(t.dist, { recursive: true, force: true })
  cpSync(localDist, t.dist, { recursive: true })
  const after = fingerprint(t.dist)
  changed += 1
  console.log(
    `[${t.id}] 注入完成: ${describeInline(before ?? { files: 0, mib: '0', entry: '-' })} → ${describeInline(after)}`,
  )
  if (before?.entry && after.entry && before.entry !== after.entry) {
    console.log(`        入口变化 ${before.entry} → ${after.entry}（新文件名 ⇒ 浏览器缓存必然失效，刷新页面即可拿到新版）`)
  }
}
console.log(changed > 0 ? `\n完成：${changed} 个目标已更新。重启 DSH shell 后生效。` : '\n无需变更。')
