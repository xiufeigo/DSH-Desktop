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
