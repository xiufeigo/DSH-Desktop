/**
 * Generate the app icon with zero dependencies: a blue rounded square with a
 * white ">_" glyph, rasterized analytically and encoded as PNG/ICO by hand.
 *
 * Outputs: build/icon.png (512px, for Linux) and build/icon.ico (multi-size,
 * for the Windows exe). Uses only node:zlib and node:fs.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'build')
mkdirSync(outDir, { recursive: true })

const BG = [0x4d, 0x6b, 0xfe] // DeepSeek-ish blue
const FG = [0xff, 0xff, 0xff]

// ── minimal PNG encoder ────────────────────────────────────────────────────
let crcTable
function crc32(buf) {
  if (crcTable === undefined) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── analytic raster: rounded square + ">_" glyph ───────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function roundedRectCoverage(x, y, size) {
  const margin = size * 0.06
  const radius = size * 0.22
  const half = size / 2 - margin
  const dx = Math.max(Math.abs(x - size / 2) - (half - radius), 0)
  const dy = Math.max(Math.abs(y - size / 2) - (half - radius), 0)
  return clamp01(0.5 - (Math.hypot(dx, dy) - radius))
}

function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby))
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
}

function glyphCoverage(x, y, size) {
  const s = size / 256
  const thickness = 19 * s
  // '>' chevron: upper-left → middle-right → lower-left
  const chevron = Math.min(
    segDist(x, y, 82 * s, 64 * s, 172 * s, 122 * s),
    segDist(x, y, 172 * s, 122 * s, 82 * s, 180 * s),
  )
  let coverage = clamp01(thickness / 2 - chevron + 0.5)
  // '_' underscore bar
  const dx = Math.max(82 * s - x, x - 172 * s, 0)
  const dy = Math.abs(y - 188 * s)
  coverage = Math.max(coverage, clamp01(thickness / 2 - Math.hypot(dx, dy) + 0.5))
  return coverage
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bg = roundedRectCoverage(x, y, size)
      const glyph = glyphCoverage(x, y, size)
      const i = (y * size + x) * 4
      const mix = glyph >= 1e-6 ? Math.min(1, glyph) : 0
      rgba[i] = Math.round(BG[0] * (1 - mix) + FG[0] * mix)
      rgba[i + 1] = Math.round(BG[1] * (1 - mix) + FG[1] * mix)
      rgba[i + 2] = Math.round(BG[2] * (1 - mix) + FG[2] * mix)
      rgba[i + 3] = Math.round(Math.max(bg, glyph) * 255)
    }
  }
  return rgba
}

/** Integer-factor box downscale (768 → 256/128/64/48/32/24/16). */
function downscale(rgba, from, to) {
  const factor = from / to
  const out = Buffer.alloc(to * to * 4)
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * from + (x * factor + sx)) * 4
          r += rgba[i]
          g += rgba[i + 1]
          b += rgba[i + 2]
          a += rgba[i + 3]
        }
      }
      const n = factor * factor
      const o = (y * to + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ── ICO container (PNG-compressed entries, Vista+) ─────────────────────────
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + 16 * entries.length
  const dirs = []
  for (const { size, buf } of entries) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(buf.length, 8)
    entry.writeUInt32LE(offset, 12)
    dirs.push(entry)
    offset += buf.length
  }
  return Buffer.concat([header, ...dirs, ...entries.map((entry) => entry.buf)])
}

const base = render(768)
writeFileSync(join(outDir, 'icon.png'), encodePng(render(512), 512))
writeFileSync(
  join(outDir, 'icon.ico'),
  encodeIco([256, 128, 64, 48, 32, 24, 16].map((size) => ({
    size,
    buf: encodePng(downscale(base, 768, size), size),
  }))),
)
console.log('make-icons: build/icon.png (512) and build/icon.ico written')
