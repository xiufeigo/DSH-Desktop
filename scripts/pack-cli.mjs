/**
 * Pack the single-binary CLI for the current platform:
 *   Windows -> dist/dsh-cli-<ver>-win-x64.exe
 *   Linux   -> dist/dsh-cli-<ver>-linux-x64
 * The launcher has the payload (Node + dsh closure) appended by the
 * build-payload bin, so the artifact is one self-contained file.
 *
 * Usage: node scripts/pack-cli.mjs [--win|--linux] [--skip-prepare]
 * Pre-pack: checks official DeepSeek Harness, syncs npm payload if needed,
 * then increments the desktop suffix (official 0.1.0-rc.7 → 0.1.0-rc.7.1).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDesktopVersion } from './desktop-version.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const plat = process.argv.includes('--linux') ? 'linux' : 'win'
if (plat === 'linux' && process.platform === 'win32') {
  throw new Error('pack-cli: Linux binary must be built on Linux; use the release workflow or a Linux box')
}

const run = (cmd, args, label, opts = {}) => {
  console.log(`pack-cli: ${label}: ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`pack-cli: ${label} failed (exit ${String(result.status)})`)
}

// npm goes through cmd.exe on Windows (same pattern as collect-notices.mjs).
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const runNpm = (args, label) => run(npmCmd, args, label, { shell: process.platform === 'win32' })

if (!process.argv.includes('--skip-prepare')) {
  const prepareArgs = ['scripts/sync-and-bump.mjs']
  if (process.argv.includes('--skip-sync')) prepareArgs.push('--skip-sync')
  if (process.argv.includes('--skip-bump')) prepareArgs.push('--skip-bump')
  run(process.execPath, prepareArgs, 'sync official payload and bump version')
}

// Stale CLI artifacts from earlier versions must not linger.
mkdirSync(join(root, 'dist'), { recursive: true })
for (const name of readdirSync(join(root, 'dist'))) {
  if (name.startsWith('dsh-cli-')) rmSync(join(root, 'dist', name), { force: true })
}

runNpm(['ci'], 'install pinned payload deps')
run(process.execPath, ['scripts/prepare-payload.mjs', plat], 'stage payload')
run(process.execPath, ['scripts/verify-payload.mjs', plat], 'verify payload')

const crateDir = join(root, 'crates', 'dsh-cli')
run('cargo', ['build', '--release'], 'build launcher', { cwd: crateDir })
const launcher = join(crateDir, 'target', 'release', plat === 'win' ? 'dsh-cli.exe' : 'dsh-cli')
if (!existsSync(launcher)) throw new Error('pack-cli: launcher binary missing after cargo build')

const out = join(root, 'dist', `dsh-cli-${readDesktopVersion()}-${plat}-x64${plat === 'win' ? '.exe' : ''}`)
run(
  'cargo',
  ['run', '--release', '--bin', 'build-payload', '--', join(root, '.work', `payload-${plat}`), launcher, out],
  'append payload',
  { cwd: crateDir },
)
console.log(`pack-cli: artifact ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`)
