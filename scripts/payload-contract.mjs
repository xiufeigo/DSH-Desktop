import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, relative } from 'node:path'

export const PAYLOAD_LIMITS = Object.freeze({
  // dsh 0.2.0 把 Office 文档能力带进了生产闭包：@deepseek-ai/libreoffice-kit
  // 的当前平台包（win32-x64 约 182 MiB，其中单个转换器 exe 就 170 MiB）。这不是
  // 上游的分发失误——官方 Electron 桌面版自己的 runtime-file-policy 也只剔除
  // 其它平台的 kit、保留当前平台的。Windows 载荷因此从约 193 MiB 涨到约 434 MiB。
  // Linux 仍天然更大：sharp/node-pty/koffi 等原生模块要同时带 glibc 与 musl 变体
  // （上游闭包增长曾把 Linux 推过 225 MiB，v0.1.1-rc.2.4 的发布作业因此失败）。
  // 512 MiB 为后续增长留出余量，同时仍然守住「体积失控」这道闸门。
  bytes: 512 * 1024 * 1024,
  files: 15_000,
})

const portablePath = (value) => value.split('\\').join('/')

export function walkFiles(root, visit) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, visit)
      continue
    }
    visit(full, entry)
  }
}

export function collectTreeStats(root) {
  let bytes = 0
  let files = 0
  walkFiles(root, (full) => {
    bytes += lstatSync(full).size
    files += 1
  })
  return { bytes, files }
}

export function findPackageCopies(nodeModulesDir, packageName) {
  const copies = []
  walkFiles(nodeModulesDir, (full) => {
    if (!full.endsWith('package.json')) return
    const manifest = JSON.parse(readFileSync(full, 'utf8'))
    if (manifest.name !== packageName) return
    copies.push({
      name: manifest.name,
      version: manifest.version,
      manifestPath: full,
      packageDir: join(full, '..'),
    })
  })
  return copies.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath))
}

function resolveFrontend(nodeModulesDir) {
  const webAppManifest = join(nodeModulesDir, '@deepseek-ai', 'dsh-web-app', 'package.json')
  if (!existsSync(webAppManifest)) {
    throw new Error('payload contract: @deepseek-ai/dsh-web-app is missing')
  }

  const webAppRequire = createRequire(webAppManifest)
  const packagePath = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  const indexPath = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const copies = findPackageCopies(nodeModulesDir, '@deepseek-ai/dsh-web-frontend')
  if (copies.length !== 1) {
    const found = copies.map((copy) => `${copy.version} at ${copy.manifestPath}`).join(', ') || 'none'
    throw new Error(`payload contract: expected one web frontend package, found ${String(copies.length)} (${found})`)
  }
  if (copies[0].manifestPath !== packagePath) {
    throw new Error('payload contract: dsh-web-app resolved a frontend outside the staged dependency closure')
  }

  return {
    version: manifest.version,
    packagePath: portablePath(relative(nodeModulesDir, packagePath)),
    indexPath: portablePath(relative(nodeModulesDir, indexPath)),
  }
}

function collectNativeModules(payloadDir) {
  const modules = []
  walkFiles(join(payloadDir, 'app', 'node_modules'), (full) => {
    if (extname(full).toLowerCase() === '.node') {
      modules.push(portablePath(relative(payloadDir, full)))
    }
  })
  modules.sort()
  if (modules.length === 0) {
    throw new Error('payload contract: no native Node modules were staged')
  }
  return modules
}

function assertMinimalNodeRuntime(payloadDir, target) {
  const nodeDir = join(payloadDir, 'node')
  const expectedBinary = target === 'win' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node')
  if (!existsSync(expectedBinary)) throw new Error(`payload contract: Node binary missing at ${expectedBinary}`)
  if (!existsSync(join(nodeDir, 'LICENSE'))) throw new Error('payload contract: Node LICENSE is missing')

  const allowed = target === 'win' ? new Set(['LICENSE', 'node.exe']) : new Set(['LICENSE', 'bin'])
  const unexpected = readdirSync(nodeDir).filter((name) => !allowed.has(name))
  if (unexpected.length > 0) {
    throw new Error(`payload contract: unexpected bundled Node tools: ${unexpected.join(', ')}`)
  }
  if (target === 'linux') {
    const unexpectedBin = readdirSync(join(nodeDir, 'bin')).filter((name) => name !== 'node')
    if (unexpectedBin.length > 0) {
      throw new Error(`payload contract: unexpected bundled Node binaries: ${unexpectedBin.join(', ')}`)
    }
  }
}

function assertPrunedFiles(payloadDir) {
  const forbidden = []
  walkFiles(join(payloadDir, 'app'), (full) => {
    if (/\.(?:d\.ts|d\.mts|d\.cts|map|pdb)$/i.test(full)) {
      forbidden.push(portablePath(relative(payloadDir, full)))
    }
  })
  if (forbidden.length > 0) {
    throw new Error(`payload contract: forbidden packaging files remain: ${forbidden.slice(0, 10).join(', ')}`)
  }
}

function assertNodePtyTarget(nodeModulesDir, target) {
  const copies = findPackageCopies(nodeModulesDir, 'node-pty')
  if (copies.length !== 1) {
    throw new Error(`payload contract: expected one node-pty package, found ${String(copies.length)}`)
  }

  const expectedPrebuild = target === 'win' ? 'win32-x64' : 'linux-x64'
  const packageDir = copies[0].packageDir
  const prebuildsDir = join(packageDir, 'prebuilds')
  if (existsSync(prebuildsDir)) {
    const unexpected = readdirSync(prebuildsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== expectedPrebuild)
      .map((entry) => entry.name)
    if (unexpected.length > 0) {
      throw new Error(`payload contract: node-pty contains non-target prebuilds: ${unexpected.join(', ')}`)
    }
  }

  const targetDir = join(prebuildsDir, expectedPrebuild)
  const targetBinding = [
    join(targetDir, 'pty.node'),
    join(targetDir, 'conpty.node'),
    join(packageDir, 'build', 'Release', 'pty.node'),
    join(packageDir, 'build', 'Release', 'conpty.node'),
  ].find((candidate) => existsSync(candidate))
  if (!targetBinding) {
    throw new Error(`payload contract: node-pty has no ${expectedPrebuild} or build/Release binding`)
  }
}

function collectFacts(payloadDir, target) {
  const nodeModulesDir = join(payloadDir, 'app', 'node_modules')
  if (!existsSync(nodeModulesDir)) throw new Error('payload contract: app/node_modules is missing')
  assertMinimalNodeRuntime(payloadDir, target)
  assertPrunedFiles(payloadDir)
  assertNodePtyTarget(nodeModulesDir, target)
  return {
    frontend: resolveFrontend(nodeModulesDir),
    nativeModules: collectNativeModules(payloadDir),
  }
}

export function writePayloadManifest(payloadDir, target) {
  const manifestPath = join(payloadDir, 'payload-manifest.json')
  const facts = collectFacts(payloadDir, target)
  let manifest = {
    schemaVersion: 1,
    target,
    architecture: 'x64',
    bytes: 0,
    files: 0,
    ...facts,
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const stats = collectTreeStats(payloadDir)
    if (stats.bytes === manifest.bytes && stats.files === manifest.files) return manifest
    manifest = { ...manifest, ...stats }
  }
  throw new Error('payload contract: payload manifest size did not converge')
}

export function verifyPayloadContract(payloadDir, target, { enforceLimits = true } = {}) {
  const manifestPath = join(payloadDir, 'payload-manifest.json')
  if (!existsSync(manifestPath)) throw new Error('payload contract: payload-manifest.json is missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.architecture !== 'x64') {
    throw new Error('payload contract: manifest target or schema does not match this build')
  }

  const stats = collectTreeStats(payloadDir)
  if (manifest.bytes !== stats.bytes || manifest.files !== stats.files) {
    throw new Error(
      `payload contract: manifest stats are stale (manifest ${String(manifest.bytes)}/${String(manifest.files)}, actual ${String(stats.bytes)}/${String(stats.files)})`,
    )
  }
  const facts = collectFacts(payloadDir, target)
  if (JSON.stringify(manifest.frontend) !== JSON.stringify(facts.frontend)) {
    throw new Error('payload contract: frontend resolution changed after staging')
  }
  if (JSON.stringify(manifest.nativeModules) !== JSON.stringify(facts.nativeModules)) {
    throw new Error('payload contract: native module list changed after staging')
  }
  if (enforceLimits && (stats.bytes > PAYLOAD_LIMITS.bytes || stats.files > PAYLOAD_LIMITS.files)) {
    throw new Error(
      `payload contract: ${String(stats.bytes)} bytes/${String(stats.files)} files exceeds ${String(PAYLOAD_LIMITS.bytes)} bytes/${String(PAYLOAD_LIMITS.files)} files`,
    )
  }
  return manifest
}
