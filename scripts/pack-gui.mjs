/**
 * Pack the Windows GUI installer (Tauri v2 + system WebView2):
 *   dist/DSH-Desktop-Setup-<ver>.exe
 * The NSIS installer carries the same staged payload as the CLI (Node runtime +
 * dsh closure + notices) under payload/, so both products share one payload
 * preparation pipeline.
 *
 * Usage: node scripts/pack-gui.mjs   (Windows only)
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './config.mjs'

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

mkdirSync(join(root, 'dist'), { recursive: true })
for (const name of readdirSync(join(root, 'dist'))) {
  if (name.startsWith('DSH-Desktop-') && name.endsWith('.exe')) rmSync(join(root, 'dist', name), { force: true })
}

runNpm(['ci'], 'install pinned payload deps')
run(process.execPath, ['scripts/prepare-payload.mjs', 'win'], 'stage payload')

// Icons may be missing on a fresh checkout — generate them first.
if (!existsSync(join(root, 'build', 'icon.ico'))) {
  run(process.execPath, ['scripts/make-icons.mjs'], 'icons')
}

const crateDir = join(root, 'crates', 'dsh-gui')
rmSync(join(crateDir, 'payload'), { recursive: true, force: true })
cpSync(join(root, '.work', 'payload-win'), join(crateDir, 'payload'), { recursive: true, force: true })
mkdirSync(join(crateDir, 'icons'), { recursive: true })
cpSync(join(root, 'build', 'icon.ico'), join(crateDir, 'icons', 'icon.ico'), { force: true })

run('npx.cmd', ['tauri', 'build'], 'tauri build', { cwd: crateDir, shell: true })

const bundle = join(crateDir, 'target', 'release', 'bundle', 'nsis')
const setups = readdirSync(bundle).filter((n) => n.endsWith('-setup.exe'))
if (setups.length === 0) throw new Error('pack-gui: no NSIS setup produced')
const out = join(root, 'dist', `DSH-Desktop-Setup-${VERSION}.exe`)
cpSync(join(bundle, setups[0]), out, { force: true })
console.log(`pack-gui: artifact ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`)
