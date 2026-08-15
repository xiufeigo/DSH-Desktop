/**
 * Stage the runtime payload for a single-binary CLI (or the GUI's installed
 * resources):
 *   <out>/node/              bundled Node runtime (fetch-node.mjs)
 *   <out>/app/node_modules/  production dependency closure, pruned
 *   <out>/THIRD_PARTY_NOTICES.txt + LICENSE
 *
 * Usage: node scripts/prepare-payload.mjs <win|linux> <out-dir>
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const plat = process.argv[2] === 'linux' ? 'linux' : 'win'
const outDir = resolve(root, process.argv[3] ?? join('.work', `payload-${plat}`))

const run = (args, label) => {
  console.log(`prepare-payload: ${label}: node ${args.join(' ')}`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`prepare-payload: ${label} failed (exit ${String(result.status)})`)
}

// 1. Node runtime (reuses the cached download).
run(['scripts/fetch-node.mjs', plat], 'node runtime')

// 2. Production closure -> out/app/node_modules (mirrors after-pack.cjs sync logic).
const destRoot = join(outDir, 'app', 'node_modules')
rmSync(join(outDir, 'app'), { recursive: true, force: true })
mkdirSync(destRoot, { recursive: true })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ls = spawnSync(
  npm,
  ['ls', '--omit=dev', '--all', '--parseable', '--silent'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' },
)
if (ls.error !== undefined) throw ls.error
let copied = 0
for (const line of (ls.stdout ?? '').split(/\r?\n/)) {
  const trimmed = line.trim()
  if (trimmed === '') continue
  const src = resolve(root, trimmed)
  const rel = relative(join(root, 'node_modules'), src)
  if (rel === '' || rel === '.' || rel.startsWith('..')) continue
  const dest = join(destRoot, rel)
  if (existsSync(dest)) continue
  mkdirSync(join(dest, '..'), { recursive: true })
  cpSync(src, dest, { recursive: true, force: true })
  copied += 1
}
console.log(`prepare-payload: copied ${copied} packages to app/node_modules`)

// 3. Prune packaging junk (never loaded at runtime; LICENSE files kept).
let prunedFiles = 0
let prunedDirs = 0
const prune = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') {
        rmSync(full, { recursive: true, force: true })
        prunedDirs += 1
      } else {
        prune(full)
      }
    } else if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts')) {
      rmSync(full, { force: true })
      prunedFiles += 1
    }
  }
}
prune(destRoot)
console.log(`prepare-payload: pruned ${prunedFiles} junk files + ${prunedDirs} test dir(s)`)

// 4. windowsHide 补丁：GUI 进程自身没有控制台，dsh 通过
//    dsh-subprocess-local 拉起 pwsh / bash / taskkill 等控制台程序时，
//    若不设 windowsHide，Windows 会为每个子进程新开一个空白终端窗口。
//    这里在载荷复制完成后给 spawn 点打补丁；若上游包结构变化导致
//    匹配失败，直接报错而不是静默失效。
{
  const subprocessIndex = join(destRoot, '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js')
  if (!existsSync(subprocessIndex)) {
    throw new Error('prepare-payload: dsh-subprocess-local/lib/index.js missing from closure')
  }
  const patch = (source, from, to, what) => {
    if (!source.includes(from)) {
      throw new Error(`prepare-payload: windowsHide patch target missing (${what}) — upstream package changed?`)
    }
    return source.replace(from, to)
  }
  let source = readFileSync(subprocessIndex, 'utf8')
  source = patch(
    source,
    'detached: platform !== "win32"',
    'detached: platform !== "win32",\n\t\twindowsHide: true',
    'spawn detached flag',
  )
  source = patch(
    source,
    '], { stdio: "ignore" });',
    '], { stdio: "ignore", windowsHide: true });',
    'taskkill spawnSync',
  )
  writeFileSync(subprocessIndex, source)
  console.log('prepare-payload: patched dsh-subprocess-local spawn points with windowsHide:true')
}

// 4. Node runtime + license material.
rmSync(join(outDir, 'node'), { recursive: true, force: true })
cpSync(join(root, 'payload', 'node'), join(outDir, 'node'), { recursive: true, force: true })
run(['scripts/collect-notices.mjs', join(outDir, 'THIRD_PARTY_NOTICES.txt')], 'third-party notices')
cpSync(join(root, 'LICENSE'), join(outDir, 'LICENSE'))

// 5. Statically linked Rust crates section (vendored manifest, see collect-rust-licenses.mjs).
const rustManifest = join(root, 'build', 'rust-licenses.txt')
if (!existsSync(rustManifest)) {
  throw new Error('prepare-payload: build/rust-licenses.txt missing — run `node scripts/collect-rust-licenses.mjs` first')
}
appendFileSync(
  join(outDir, 'THIRD_PARTY_NOTICES.txt'),
  `\n${readFileSync(rustManifest, 'utf8')}`,
)

console.log(`prepare-payload: staged payload at ${outDir}`)
