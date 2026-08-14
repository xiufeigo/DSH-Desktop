/**
 * Sync the bundled DeepSeek Harness payload to the latest npm releases.
 *
 * The payload pin has ONE source of truth: package.json dependencies
 * (`@deepseek-ai/dsh` + `@deepseek-ai/dsh-web-frontend`, which follows its
 * own version scheme). This script bumps both to their latest, re-installs,
 * and verifies the runtime closure:
 *
 *   node scripts/update-dsh.mjs          install latest, update package.json
 *   node scripts/update-dsh.mjs --check  exit 2 when upstream is newer (CI)
 *
 * After a sync: node scripts/pack-cli.mjs / node scripts/pack-gui.mjs locally,
 * or push a v* tag and let release.yml build every platform.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
process.env.npm_config_cache ??= join(root, '.cache', 'npm')

/** Latest published version of a package (first line of `npm view`). */
function latestVersion(name) {
  const result = spawnSync('npm', ['view', name, 'version'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  const version = (result.stdout ?? '').trim().split(/\r?\n/)[0]
  if (result.status !== 0 || version === '') {
    throw new Error(`update-dsh: npm view ${name} failed (exit ${String(result.status)})`)
  }
  return version
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const current = manifest.dependencies['@deepseek-ai/dsh']
const currentWeb = manifest.dependencies['@deepseek-ai/dsh-web-frontend']
const latest = latestVersion('@deepseek-ai/dsh')
const latestWeb = latestVersion('@deepseek-ai/dsh-web-frontend')
console.log(`update-dsh: current dsh=${current} web=${currentWeb}; latest dsh=${latest} web=${latestWeb}`)

if (process.argv.includes('--check')) {
  process.exit(current === latest && currentWeb === latestWeb ? 0 : 2)
}
if (current === latest && currentWeb === latestWeb) {
  console.log('update-dsh: already up to date')
  process.exit(0)
}

console.log(`update-dsh: installing @deepseek-ai/dsh@${latest} @deepseek-ai/dsh-web-frontend@${latestWeb}`)
const install = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--save-exact', `@deepseek-ai/dsh@${latest}`, `@deepseek-ai/dsh-web-frontend@${latestWeb}`],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
)
if (install.status !== 0) process.exit(install.status ?? 1)

// Verify the two entries the shell depends on, then smoke the CLI itself.
const verify = spawnSync(process.execPath, ['-e', `
  require.resolve('@deepseek-ai/dsh/package.json')
  require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
`], { cwd: root, stdio: 'inherit' })
if (verify.status !== 0) throw new Error('update-dsh: payload closure verification failed')

const smoke = spawnSync(process.execPath, ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--version'], {
  cwd: root,
  stdio: 'inherit',
})
if (smoke.status !== 0) throw new Error('update-dsh: dsh smoke failed')
console.log('update-dsh: done — rebuild with `node scripts/pack-cli.mjs` / `node scripts/pack-gui.mjs` or push a v* tag')
