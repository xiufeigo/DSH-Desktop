import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { findPackageCopies } from './payload-contract.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('dsh is the only direct upstream runtime dependency', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['@deepseek-ai/dsh'])
})

test('dsh-web-app resolves the only installed frontend copy', () => {
  const rootRequire = createRequire(join(root, 'package.json'))
  const dshRequire = createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'))
  const webAppRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const resolvedFrontend = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  const copies = findPackageCopies(join(root, 'node_modules'), '@deepseek-ai/dsh-web-frontend')

  assert.equal(copies.length, 1)
  assert.equal(copies[0].manifestPath, resolvedFrontend)
})

test('payload preparation rejects destructive output paths before doing work', () => {
  for (const unsafeOutput of [
    root,
    resolve(root, '..'),
    join(root, '.work', 'benchmark-data'),
    join(root, '.work', 'nested', 'payload-win'),
  ]) {
    const result = spawnSync(
      process.execPath,
      ['scripts/prepare-payload.mjs', 'win', unsafeOutput],
      { cwd: root, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /output directory must be a .*payload-\* path/)
    assert.equal(result.stdout, '')
  }
})

test('desktop version follows official tag plus incrementing pack suffix', async () => {
  const { nextDesktopVersion } = await import('./desktop-version.mjs')
  assert.equal(nextDesktopVersion('0.1.0-rc.7', '0.1.2'), '0.1.0-rc.7.1')
  assert.equal(nextDesktopVersion('0.1.0-rc.7', '0.1.0-rc.7'), '0.1.0-rc.7.1')
  assert.equal(nextDesktopVersion('0.1.0-rc.7', '0.1.0-rc.7.1'), '0.1.0-rc.7.2')
  assert.equal(nextDesktopVersion('0.1.0-rc.7', '0.1.0-rc.7.9'), '0.1.0-rc.7.10')
  assert.equal(nextDesktopVersion('0.1.0-rc.8', '0.1.0-rc.7.3'), '0.1.0-rc.8.1')
})
