/**
 * Audit the statically linked Rust crate closure and generate a vendored
 * license manifest: build/rust-licenses.txt.
 *
 * Usage: node scripts/collect-rust-licenses.mjs [output-file]
 * Requires `cargo license` (cargo install cargo-license --locked).
 *
 * The output is committed to the repo and appended to THIRD_PARTY_NOTICES.txt
 * by prepare-payload.mjs, so CI does not need cargo-license. Regenerate after
 * changing Cargo.toml/Cargo.lock dependencies.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outPath = process.argv[2] ?? join(root, 'build', 'rust-licenses.txt')

const COPLEFT = /\b(GPL|AGPL|LGPL|MPL|EPL|CDDL|CPL|SSPL)\b/
const electionNote = new Map([
  // Tri-licensed crates: we elect the permissive options.
  ['Apache-2.0 OR LGPL-2.1-or-later OR MIT', '（本项目选择 MIT / Apache-2.0 许可）'],
])

const crates = new Map()
for (const manifest of ['crates/dsh-cli/Cargo.toml', 'crates/dsh-gui/Cargo.toml']) {
  const result = spawnSync('cargo', ['license', '--manifest-path', join(root, manifest), '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`collect-rust-licenses: cargo license failed for ${manifest}`)
  for (const entry of JSON.parse(result.stdout)) {
    const id = `${entry.name}@${entry.version}`
    if (!crates.has(id)) crates.set(id, entry)
  }
}

const rows = [...crates.values()]
  .map((e) => ({
    name: e.name,
    version: e.version,
    license: e.license ?? '(none)',
    authors: (e.authors ?? '').replace(/\s+/g, ' ').trim(),
    repository: e.repository ?? '',
  }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))

const copyleft = rows.filter((r) => COPLEFT.test(r.license))
const lines = [
  'Rust crates statically linked into the dsh-gui / dsh-cli binaries',
  '=================================================================',
  `Generated ${new Date().toISOString()} with cargo-license over the full cargo dependency closure of both crates.`,
  '',
  'For crates declaring multiple license options, this project elects the permissive',
  'option (noted inline). No crate in this list is licensed under GPL/AGPL/EPL/CDDL/SSPL.',
  'MPL-2.0 crates (file-level copyleft) are redistributed unmodified; their source is the',
  'corresponding unmodified crates.io package.',
  '',
  'name version — license (SPDX)',
  'authors | repository',
  '',
  ...rows.map((r) => {
    const lic = r.license + (electionNote.get(r.license) ?? '')
    return `${r.name} ${r.version} — ${lic}\n  ${r.authors || '(no authors field)'}${r.repository ? ` | ${r.repository}` : ''}`
  }),
  '',
  '',
]

// Append the full text of every license type that appears in the closure.
const textFiles = new Map([
  ['MIT', 'MIT.txt'],
  ['Apache-2.0', 'Apache-2.0.txt'],
  ['BSD-3-Clause', 'BSD-3-Clause.txt'],
  ['ISC', 'ISC.txt'],
  ['Zlib', 'Zlib.txt'],
  ['Unicode-3.0', 'Unicode-DFS-2016.txt'],
  ['MPL-2.0', 'MPL-2.0.txt'],
])
const needed = new Set()
for (const r of rows) {
  for (const [spdx] of textFiles) {
    if (r.license.includes(spdx)) needed.add(spdx)
  }
}
for (const spdx of [...needed].sort()) {
  const file = join(root, 'build', 'licenses', textFiles.get(spdx))
  if (!existsSync(file)) continue
  lines.push('='.repeat(72), `${spdx} — full license text (applies to the crates above declaring it)`, '-'.repeat(72), '', readFileSync(file, 'utf8').trim(), '', '')
}

writeFileSync(outPath, lines.join('\n'))
console.log(`collect-rust-licenses: ${rows.length} crates -> ${outPath}`)
console.log(`copyleft flags: ${copyleft.length === 0 ? 'none' : copyleft.map((r) => `${r.name}@${r.version} -> ${r.license}`).join(', ')}`)
