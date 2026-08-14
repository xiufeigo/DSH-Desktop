/**
 * Generate THIRD_PARTY_NOTICES.txt for the bundled production dependency
 * closure: one section per package (name@version, declared license, and its
 * license text when the package ships one). Runs during pack so every
 * artifact carries an accurate manifest of what it bundles.
 *
 * Usage: node scripts/collect-notices.mjs [output-file]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outPath = process.argv[2] ?? join(root, 'THIRD_PARTY_NOTICES.txt')
const MAX_LICENSE_TEXT = 50_000

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ls', '--omit=dev', '--all', '--parseable', '--silent'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' },
)
if (result.error !== undefined) throw result.error

const declaredLicense = (pkg) => {
  if (typeof pkg.license === 'string') return pkg.license
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((entry) => (typeof entry === 'string' ? entry : entry.type)).join(' OR ')
  }
  return 'UNKNOWN'
}

const sections = []
const seen = new Set()
for (const line of (result.stdout ?? '').split(/\r?\n/)) {
  const trimmed = line.trim()
  if (trimmed === '') continue
  const src = resolve(root, trimmed)
  const rel = relative(join(root, 'node_modules'), src)
  if (rel === '' || rel === '.' || rel.startsWith('..')) continue
  if (!existsSync(join(src, 'package.json'))) continue
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  const id = `${pkg.name}@${pkg.version}`
  if (seen.has(id)) continue
  seen.add(id)
  const licenseFile = readdirSync(src).find((name) => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(name))
  let text = ''
  if (licenseFile !== undefined) {
    const full = join(src, licenseFile)
    if (statSync(full).isFile()) text = readFileSync(full, 'utf8').slice(0, MAX_LICENSE_TEXT)
  }
  sections.push({ id, license: declaredLicense(pkg), text })
}
sections.sort((a, b) => a.id.localeCompare(b.id))

const header = [
  'DSH Desktop — Third-Party Notices',
  '==================================',
  `Generated ${new Date().toISOString()} from the bundled production dependency closure.`,
  '',
  'Each section lists a bundled third-party package, the license it declares,',
  'and its license text where the package ships one (when absent, the license',
  'field in the package.json applies). The Node.js runtime is covered by its',
  'own license file shipped next to this one: node/LICENSE.',
  '',
].join('\n')

const body = sections
  .map((s) => `${'='.repeat(72)}\n${s.id} — ${s.license}\n${'-'.repeat(72)}\n${s.text.trim() || '(no license text shipped with this package; the package.json license field applies)'}\n`)
  .join('\n')

// The @img/sharp-* prebuilt packages (pulled in via sharp -> @deepseek-ai/dsh-attachment-local)
// declare "Apache-2.0 AND LGPL-3.0-or-later" because they bundle libvips (LGPL-2.1-or-later)
// as a dynamically linked DLL, but they only ship the Apache-2.0 text. LGPL requires the
// license text to be conveyed, so append it explicitly.
const supplements = []
if ([...seen].some((id) => id.startsWith('@img/sharp-'))) {
  const lgplPath = join(root, 'build', 'licenses', 'LGPL-3.0.txt')
  const lgplText = existsSync(lgplPath)
    ? readFileSync(lgplPath, 'utf8').trim()
    : '(LGPL-3.0 text missing from build/licenses/LGPL-3.0.txt)'
  supplements.push(
    `${'='.repeat(72)}\nlibvips — GNU Lesser General Public License (supplement)\n${'-'.repeat(72)}\n` +
    'libvips (bundled as libvips-42.dll / libvips-cpp inside the @img/sharp-* prebuilt packages,\n' +
    'pulled in via sharp -> @deepseek-ai/dsh-attachment-local) is licensed under LGPL-2.1-or-later.\n' +
    'The @img/sharp-* packages declare "Apache-2.0 AND LGPL-3.0-or-later" but ship only the\n' +
    'Apache-2.0 text, so the LGPL-3.0 text is reproduced here ("or-later" permits using version 3.0).\n\n' +
    lgplText,
  )
}
const supplementBlock = supplements.length > 0 ? `\n${supplements.join('\n')}\n` : ''

writeFileSync(outPath, `${header}\n${body}${supplementBlock}`)
console.log(`collect-notices: ${String(sections.length)} packages -> ${outPath}`)
