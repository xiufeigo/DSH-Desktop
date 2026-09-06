/**
 * DSH Desktop version is the upstream DeepSeek Harness version plus a
 * local pack suffix: official `0.1.0-rc.7` → desktop `0.1.0-rc.7.1`.
 * Each pack increments the suffix; a new official version resets it to 1.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UPSTREAM_REPO = 'https://github.com/deepseek-ai/deepseek-harness'
export const UPSTREAM_PACKAGE = '@deepseek-ai/dsh'

/**
 * npm-semver ordering for the simple version pins this repo uses
 * (`0.1.2-alpha.2`, `0.1.1-rc.2`, `0.1.0` — full prerelease rules).
 * Returns -1 / 0 / 1 like a comparator.
 */
export function compareVersions(a, b) {
  const parse = (version) => {
    const [core, prerelease = ''] = version.replace(/^v/, '').split('-')
    const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { major, minor, patch, prerelease: prerelease === '' ? [] : prerelease.split('.') }
  }
  const left = parse(a)
  const right = parse(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  // A release outranks any prerelease of the same version triple.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const x = left.prerelease[index]
    const y = right.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xNumeric !== yNumeric) {
      // Numeric identifiers compare lower than alphanumeric ones.
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

const root = fileURLToPath(new URL('..', import.meta.url))

export function nextDesktopVersion(official, currentDesktop) {
  const prefix = `${official}.`
  if (currentDesktop.startsWith(prefix)) {
    const rest = currentDesktop.slice(prefix.length)
    if (/^[1-9]\d*$/.test(rest)) return `${official}.${Number(rest) + 1}`
  }
  return `${official}.1`
}

export function readDesktopVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

export function readPinnedDshVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies[UPSTREAM_PACKAGE]
}

function replaceOnce(path, pattern, replacement, label) {
  const previous = readFileSync(path, 'utf8')
  const next = previous.replace(pattern, replacement)
  if (next === previous) {
    if (previous.includes(replacement)) return
    throw new Error(`desktop-version: failed to update ${label} in ${path}`)
  }
  writeFileSync(path, next)
}

export function writeDesktopVersion(version) {
  replaceOnce(
    join(root, 'scripts', 'config.mjs'),
    /export const VERSION = '[^']+'/,
    `export const VERSION = '${version}'`,
    'VERSION',
  )
  replaceOnce(
    join(root, 'package.json'),
    /^  "version": "[^"]+"/m,
    `  "version": "${version}"`,
    'package.json version',
  )
  const lockPath = join(root, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = version
  if (lock.packages?.[''] !== undefined) lock.packages[''].version = version
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  replaceOnce(
    join(root, 'crates', 'dsh-gui', 'Cargo.toml'),
    /^version = "[^"]+"/m,
    `version = "${version}"`,
    'dsh-gui Cargo.toml',
  )
  replaceOnce(
    join(root, 'crates', 'dsh-cli', 'Cargo.toml'),
    /^version = "[^"]+"/m,
    `version = "${version}"`,
    'dsh-cli Cargo.toml',
  )
  replaceOnce(
    join(root, 'crates', 'dsh-gui', 'tauri.conf.json'),
    /^  "version": "[^"]+"/m,
    `  "version": "${version}"`,
    'tauri.conf.json version',
  )
}
