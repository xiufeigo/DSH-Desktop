/**
 * Pre-pack gate: check official DeepSeek Harness, sync the npm payload if it
 * moved, then bump the desktop pack suffix.
 *
 *   node scripts/sync-and-bump.mjs
 *   node scripts/sync-and-bump.mjs --skip-sync
 *   node scripts/sync-and-bump.mjs --skip-bump
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UPSTREAM_PACKAGE,
  UPSTREAM_REPO,
  nextDesktopVersion,
  readDesktopVersion,
  readPinnedDshVersion,
  writeDesktopVersion,
} from './desktop-version.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const skipSync = process.argv.includes('--skip-sync')
const skipBump = process.argv.includes('--skip-bump')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd !== process.execPath,
    ...opts,
  })
  if (result.error) throw result.error
  return result
}

function latestNpmVersion() {
  const result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', UPSTREAM_PACKAGE, 'version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const version = (result.stdout ?? '').trim().split(/\r?\n/)[0]
  if (result.status !== 0 || version === '') {
    throw new Error(`sync-and-bump: npm view ${UPSTREAM_PACKAGE} failed`)
  }
  return version
}

function githubTags() {
  const result = run('git', ['ls-remote', '--tags', '--refs', `${UPSTREAM_REPO}.git`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    console.warn(`sync-and-bump: git ls-remote ${UPSTREAM_REPO} failed; continuing with npm`)
    return []
  }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const ref = line.split('\t')[1] ?? ''
      return ref.replace('refs/tags/', '').replace(/^dsh-v/, '').replace(/^v/, '')
    })
    .filter(Boolean)
}

const pinned = readPinnedDshVersion()
const npmLatest = latestNpmVersion()
const tags = githubTags()
console.log(`sync-and-bump: official repo ${UPSTREAM_REPO}`)
console.log(`sync-and-bump: pinned ${UPSTREAM_PACKAGE}=${pinned}; npm latest=${npmLatest}`)
if (tags.length > 0) {
  const unique = [...new Set(tags)]
  console.log(`sync-and-bump: GitHub tags ${unique.slice(-8).join(', ')}`)
  if (!unique.includes(npmLatest)) {
    console.warn(`sync-and-bump: npm latest ${npmLatest} is not a GitHub tag; payload still follows npm`)
  }
}

if (!skipSync && pinned !== npmLatest) {
  console.log(`sync-and-bump: syncing payload to ${npmLatest}`)
  const sync = run(process.execPath, ['scripts/update-dsh.mjs'], { stdio: 'inherit' })
  if (sync.status !== 0) process.exit(sync.status ?? 1)
} else if (pinned === npmLatest) {
  console.log('sync-and-bump: payload already matches npm latest')
}

const official = readPinnedDshVersion()
const current = readDesktopVersion()
if (skipBump) {
  console.log(`sync-and-bump: keeping desktop version ${current}`)
  process.exit(0)
}

const next = nextDesktopVersion(official, current)
if (next === current) {
  console.log(`sync-and-bump: desktop version already ${current}`)
  process.exit(0)
}
writeDesktopVersion(next)
console.log(`sync-and-bump: desktop version ${current} → ${next} (official ${official})`)
