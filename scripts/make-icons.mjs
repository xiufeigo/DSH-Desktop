/**
 * Generate the application icons from the repository-owned DeepSeek mark.
 * Tauri's icon pipeline performs the SVG rasterization and emits a Windows
 * multi-resolution ICO plus the PNG used by other package targets.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'assets', 'deepseek-icon.svg')
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const generatedDir = join(root, '.work', 'generated-icons')
const outDir = join(root, 'build')

if (!existsSync(source)) throw new Error(`make-icons: source icon missing: ${source}`)
if (!existsSync(cli)) throw new Error('make-icons: @tauri-apps/cli missing; run `npm ci` first')

rmSync(generatedDir, { recursive: true, force: true })
mkdirSync(generatedDir, { recursive: true })
const result = spawnSync(
  process.execPath,
  [cli, 'icon', source, '--output', generatedDir],
  { cwd: root, stdio: 'inherit' },
)
if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`make-icons: Tauri icon generation failed (exit ${String(result.status)})`)
}

const generatedIco = join(generatedDir, 'icon.ico')
const generatedPng = join(generatedDir, 'icon.png')
if (!existsSync(generatedIco) || !existsSync(generatedPng)) {
  throw new Error('make-icons: Tauri did not generate icon.ico and icon.png')
}

mkdirSync(outDir, { recursive: true })
cpSync(generatedIco, join(outDir, 'icon.ico'), { force: true })
cpSync(generatedPng, join(outDir, 'icon.png'), { force: true })
rmSync(generatedDir, { recursive: true, force: true })

console.log(
  `make-icons: DeepSeek icon written (${String(statSync(join(outDir, 'icon.ico')).size)} byte ICO)`,
)
