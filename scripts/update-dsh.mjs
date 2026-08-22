/**
 * Sync the bundled DeepSeek Harness payload to the latest npm releases.
 *
 * The payload pin has ONE source of truth: package.json's direct
 * `@deepseek-ai/dsh` dependency. dsh-web-app owns the compatible frontend
 * version. This script bumps dsh only, then verifies that runtime closure:
 *
 *   node scripts/update-dsh.mjs          install latest, update package.json
 *   node scripts/update-dsh.mjs --check  exit 2 when upstream is newer (CI)
 *
 * After a payload sync, desktop versioning is handled by
 * `scripts/sync-and-bump.mjs` (official 0.1.0-rc.7 → desktop 0.1.0-rc.7.1).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPackageCopies } from './payload-contract.mjs'

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
if (manifest.dependencies['@deepseek-ai/dsh-web-frontend'] !== undefined) {
  throw new Error('update-dsh: @deepseek-ai/dsh-web-frontend must not be a direct dependency')
}
const latest = latestVersion('@deepseek-ai/dsh')
console.log(`update-dsh: current dsh=${current}; latest dsh=${latest}`)

function verifyClosure() {
  const rootRequire = createRequire(join(root, 'package.json'))
  const dshManifest = rootRequire.resolve('@deepseek-ai/dsh/package.json')
  const dshRequire = createRequire(dshManifest)
  const webAppManifest = dshRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
  const webAppRequire = createRequire(webAppManifest)
  const frontendManifest = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')

  const frontendCopies = findPackageCopies(join(root, 'node_modules'), '@deepseek-ai/dsh-web-frontend')
  if (frontendCopies.length !== 1 || frontendCopies[0].manifestPath !== frontendManifest) {
    const found = frontendCopies.map((copy) => `${copy.version} at ${copy.manifestPath}`).join(', ') || 'none'
    throw new Error(`update-dsh: expected dsh-web-app to resolve the only frontend copy; found ${found}`)
  }
  console.log(`update-dsh: verified frontend ${frontendCopies[0].version} from dsh-web-app`)
}

if (process.argv.includes('--check')) {
  verifyClosure()
  process.exit(current === latest ? 0 : 2)
}
if (current === latest) {
  verifyClosure()
  console.log('update-dsh: already up to date')
  process.exit(0)
}

console.log(`update-dsh: installing @deepseek-ai/dsh@${latest}`)
const install = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--save-exact', `@deepseek-ai/dsh@${latest}`],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
)
if (install.status !== 0) process.exit(install.status ?? 1)

verifyClosure()

const smoke = spawnSync(process.execPath, ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--version'], {
  cwd: root,
  stdio: 'inherit',
})
if (smoke.status !== 0) throw new Error('update-dsh: dsh smoke failed')
console.log('update-dsh: done - rebuild with `node scripts/pack-cli.mjs` / `node scripts/pack-gui.mjs` or push a v* tag')
