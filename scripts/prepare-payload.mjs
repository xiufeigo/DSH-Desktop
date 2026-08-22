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
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPackageCopies, verifyPayloadContract, writePayloadManifest } from './payload-contract.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const plat = process.argv[2]
if (plat !== 'win' && plat !== 'linux') {
  throw new Error('prepare-payload: target must be exactly "win" or "linux"')
}
if (process.arch !== 'x64') {
  throw new Error(`prepare-payload: only x64 payloads are supported, got ${process.arch}`)
}
const outDir = resolve(root, process.argv[3] ?? join('.work', `payload-${plat}`))
const workRoot = resolve(root, '.work')
const pathKey = (path) => process.platform === 'win32' ? path.toLowerCase() : path
const outFromWork = relative(workRoot, outDir)
if (
  outFromWork === '' ||
  outFromWork === '..' ||
  outFromWork.startsWith(`..${sep}`) ||
  isAbsolute(outFromWork) ||
  pathKey(dirname(outDir)) !== pathKey(workRoot) ||
  !basename(outDir).startsWith('payload-')
) {
  throw new Error(`prepare-payload: output directory must be a ${workRoot}${sep}payload-* path, got ${outDir}`)
}

mkdirSync(workRoot, { recursive: true })
const workStat = lstatSync(workRoot)
const realRoot = realpathSync(root)
const realWorkRoot = realpathSync(workRoot)
if (
  !workStat.isDirectory() ||
  workStat.isSymbolicLink() ||
  pathKey(dirname(realWorkRoot)) !== pathKey(realRoot)
) {
  throw new Error(`prepare-payload: .work must be a real directory directly below the repository, got ${realWorkRoot}`)
}
if (existsSync(outDir)) {
  const outStat = lstatSync(outDir)
  const realOutDir = realpathSync(outDir)
  if (
    !outStat.isDirectory() ||
    outStat.isSymbolicLink() ||
    pathKey(dirname(realOutDir)) !== pathKey(realWorkRoot)
  ) {
    throw new Error(`prepare-payload: refusing to replace non-directory or redirected output ${realOutDir}`)
  }
}

const run = (args, label) => {
  console.log(`prepare-payload: ${label}: node ${args.join(' ')}`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`prepare-payload: ${label} failed (exit ${String(result.status)})`)
}

// 1. Node runtime (reuses the cached download).
run(['scripts/fetch-node.mjs', plat], 'node runtime')
rmSync(outDir, { recursive: true, force: true })

// 2. Production closure -> out/app/node_modules (mirrors after-pack.cjs sync logic).
const destRoot = join(outDir, 'app', 'node_modules')
mkdirSync(destRoot, { recursive: true })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ls = spawnSync(
  npm,
  ['ls', '--omit=dev', '--all', '--parseable', '--silent'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
)
if (ls.error !== undefined) throw ls.error
if (ls.status !== 0) {
  throw new Error(`prepare-payload: npm dependency tree is invalid (exit ${String(ls.status)}):\n${ls.stderr ?? ''}`)
}
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

// 3. Keep only the native prebuild for this target. Linux node-pty may use
// build/Release instead of a prebuild, which is intentionally preserved.
// Windows node-pty 1.2 ships conpty.node (older builds used pty.node).
const nodePtyCopies = findPackageCopies(destRoot, 'node-pty')
if (nodePtyCopies.length !== 1) {
  throw new Error(`prepare-payload: expected one node-pty package, found ${String(nodePtyCopies.length)}`)
}
const targetPrebuild = plat === 'win' ? 'win32-x64' : 'linux-x64'
const prebuildsDir = join(nodePtyCopies[0].packageDir, 'prebuilds')
if (existsSync(prebuildsDir)) {
  for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== targetPrebuild) {
      rmSync(join(prebuildsDir, entry.name), { recursive: true, force: true })
    }
  }
}
rmSync(join(nodePtyCopies[0].packageDir, 'build', 'Debug'), { recursive: true, force: true })

// 4. Prune files that cannot participate in JavaScript runtime resolution.
// LICENSE/NOTICE, Markdown, source files, runtime config and package manifests stay.
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
    } else if (/\.(?:map|pdb|d\.ts|d\.mts|d\.cts)$/i.test(entry.name)) {
      rmSync(full, { force: true })
      prunedFiles += 1
    }
  }
}
prune(destRoot)
console.log(`prepare-payload: pruned ${prunedFiles} non-runtime files + ${prunedDirs} test dir(s)`)

// 5. windowsHide 补丁：GUI 进程自身没有控制台，dsh 通过
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
  const taskkillFrom = '], { stdio: "ignore" });'
  const taskkillTo = '], { stdio: "ignore", windowsHide: true });'
  const taskkillHits = source.split(taskkillFrom).length - 1
  if (taskkillHits === 0) {
    throw new Error('prepare-payload: windowsHide patch target missing (taskkill spawnSync) — upstream package changed?')
  }
  source = source.split(taskkillFrom).join(taskkillTo)
  writeFileSync(subprocessIndex, source)
  console.log(
    `prepare-payload: patched dsh-subprocess-local spawn points with windowsHide:true (${String(taskkillHits)} taskkill site(s))`,
  )
}

// 6. The shell invokes only Node itself. npm, npx and corepack are not runtime
// dependencies, so stage the executable and the upstream license only.
const fetchedNode = join(root, 'payload', 'node')
const stagedNode = join(outDir, 'node')
mkdirSync(plat === 'win' ? stagedNode : join(stagedNode, 'bin'), { recursive: true })
cpSync(
  plat === 'win' ? join(fetchedNode, 'node.exe') : join(fetchedNode, 'bin', 'node'),
  plat === 'win' ? join(stagedNode, 'node.exe') : join(stagedNode, 'bin', 'node'),
  { force: true, preserveTimestamps: true },
)
cpSync(join(fetchedNode, 'LICENSE'), join(stagedNode, 'LICENSE'), { force: true })
run(['scripts/collect-notices.mjs', join(outDir, 'THIRD_PARTY_NOTICES.txt')], 'third-party notices')
cpSync(join(root, 'LICENSE'), join(outDir, 'LICENSE'))

// 7. Statically linked Rust crates section (vendored manifest, see collect-rust-licenses.mjs).
const rustManifest = join(root, 'build', 'rust-licenses.txt')
if (!existsSync(rustManifest)) {
  throw new Error('prepare-payload: build/rust-licenses.txt missing — run `node scripts/collect-rust-licenses.mjs` first')
}
appendFileSync(
  join(outDir, 'THIRD_PARTY_NOTICES.txt'),
  `\n${readFileSync(rustManifest, 'utf8')}`,
)

const manifest = writePayloadManifest(outDir, plat)
verifyPayloadContract(outDir, plat)
console.log(
  `prepare-payload: staged ${String(manifest.files)} files, ${(manifest.bytes / 1024 / 1024).toFixed(1)} MiB, ` +
  `frontend ${manifest.frontend.version}, ${String(manifest.nativeModules.length)} native module(s) at ${outDir}`,
)
