/**
 * Pack the Windows GUI installer (Tauri v2 + system WebView2):
 *   dist/DSH-Desktop-Setup-<ver>.exe
 * The NSIS installer carries the same staged payload as the CLI (Node runtime +
 * dsh closure + notices) under payload/, so both products share one payload
 * preparation pipeline.
 *
 * Usage: node scripts/pack-gui.mjs [--skip-prepare]
 * Pre-pack: checks official DeepSeek Harness, syncs npm payload if needed,
 * then increments the desktop suffix (official 0.1.0-rc.7 → 0.1.0-rc.7.1).
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDesktopVersion } from './desktop-version.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.platform !== 'win32') {
  throw new Error('pack-gui: GUI 目前只做 Windows 端；请在 Windows 上构建')
}

const run = (cmd, args, label, opts = {}) => {
  console.log(`pack-gui: ${label}: ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`pack-gui: ${label} failed (exit ${String(result.status)})`)
}

const runNpm = (args, label) =>
  run('npm.cmd', args, label, { shell: true })

if (!process.argv.includes('--skip-prepare')) {
  const prepareArgs = ['scripts/sync-and-bump.mjs']
  if (process.argv.includes('--skip-sync')) prepareArgs.push('--skip-sync')
  if (process.argv.includes('--skip-bump')) prepareArgs.push('--skip-bump')
  run(process.execPath, prepareArgs, 'sync official payload and bump version')
}

mkdirSync(join(root, 'dist'), { recursive: true })
for (const name of readdirSync(join(root, 'dist'))) {
  if (name.startsWith('DSH-Desktop-') && name.endsWith('.exe')) rmSync(join(root, 'dist', name), { force: true })
}

runNpm(['ci'], 'install pinned payload deps')
run(process.execPath, ['scripts/prepare-payload.mjs', 'win'], 'stage payload')
run(process.execPath, ['scripts/verify-payload.mjs', 'win'], 'verify payload')

// Always regenerate from the repository-owned source so packaging cannot reuse
// a stale ICO left by an earlier checkout.
run(process.execPath, ['scripts/make-icons.mjs'], 'icons')

const crateDir = join(root, 'crates', 'dsh-gui')
rmSync(join(crateDir, 'payload'), { recursive: true, force: true })
cpSync(join(root, '.work', 'payload-win'), join(crateDir, 'payload'), { recursive: true, force: true })
mkdirSync(join(crateDir, 'icons'), { recursive: true })
cpSync(join(root, 'build', 'icon.ico'), join(crateDir, 'icons', 'icon.ico'), { force: true })

// 清掉上一次构建残留的 setup：tauri build 不会删除旧版本安装包，
// 否则按目录顺序取 setups[0] 可能拿到旧版本产物（例如 0.1.0 排在
// 0.1.1 前面，导致新包名里装的是旧内容）。
const targetDir = process.env.CARGO_TARGET_DIR || join(crateDir, 'target')
const bundle = join(targetDir, 'release', 'bundle', 'nsis')
if (existsSync(bundle)) {
  for (const name of readdirSync(bundle)) {
    if (name.endsWith('-setup.exe')) rmSync(join(bundle, name), { force: true })
  }
}

run('npx.cmd', ['tauri', 'build'], 'tauri build', { cwd: crateDir, shell: true })

const setups = readdirSync(bundle).filter((n) => n.endsWith('-setup.exe'))
if (setups.length === 0) throw new Error('pack-gui: no NSIS setup produced')
const version = readDesktopVersion()
const out = join(root, 'dist', `DSH-Desktop-Setup-${version}.exe`)
cpSync(join(bundle, setups[0]), out, { force: true })
console.log(`pack-gui: artifact ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`)
