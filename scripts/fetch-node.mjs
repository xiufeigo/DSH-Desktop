/**
 * Download the official Node.js distribution for the target platform and
 * extract it into payload/node/. Users never install Node themselves — the
 * runtime rides inside the app.
 *
 * Usage: node scripts/fetch-node.mjs [win|linux]   (default: current platform)
 *
 * Extraction reuses the system `tar`: bsdtar on Windows 10+ handles zip and
 * tar.xz alike, and GNU tar does on Linux.
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { NODE_CHANNEL, NODE_DIST_BASES } from './config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = process.argv[2] === 'win' ? 'win32' : process.argv[2] === 'linux' ? 'linux' : process.platform
const plat = target === 'win32' ? 'win' : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

/** First base that serves a matching release wins (primary → mirror). */
async function resolveRelease() {
  let lastError
  // Newer index.json names Windows archives with suffixes (win-x64-zip);
  // Linux keeps the bare platform name (tar.xz).
  const assetFile = plat === 'win' ? `${plat}-${arch}-zip` : `${plat}-${arch}`
  for (const base of NODE_DIST_BASES) {
    try {
      const index = await (await fetch(`${base}/index.json`)).json()
      const match = index.find(
        (entry) => entry.version.startsWith(`v${NODE_CHANNEL}.`)
          && Array.isArray(entry.files)
          && entry.files.includes(assetFile),
      )
      if (match !== undefined) return { base, match }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`fetch-node: no Node ${NODE_CHANNEL} release with ${assetFile} on any mirror (last: ${lastError})`)
}

const { base, match } = await resolveRelease()

const asset = `node-${match.version}-${plat}-${arch}.${plat === 'win' ? 'zip' : 'tar.xz'}`
const cacheDir = join(root, '.cache')
mkdirSync(cacheDir, { recursive: true })
const archive = join(cacheDir, asset)

if (!existsSync(archive)) {
  console.log(`fetch-node: downloading ${base}/${match.version}/${asset}`)
  const response = await fetch(`${base}/${match.version}/${asset}`)
  if (!response.ok || response.body === null) {
    throw new Error(`fetch-node: download failed (HTTP ${String(response.status)})`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
}

const stage = join(cacheDir, 'node-extract')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
console.log('fetch-node: extracting with system tar')
execFileSync('tar', ['-xf', archive, '-C', stage], { stdio: 'inherit' })

const payloadNode = join(root, 'payload', 'node')
rmSync(payloadNode, { recursive: true, force: true })
mkdirSync(join(root, 'payload'), { recursive: true })
renameSync(join(stage, `node-${match.version}-${plat}-${arch}`), payloadNode)

const nodeBin = plat === 'win' ? join(payloadNode, 'node.exe') : join(payloadNode, 'bin', 'node')
console.log(`fetch-node: runtime ready at payload/node (${match.version})`)
execFileSync(nodeBin, ['--version'], { stdio: 'inherit' })
