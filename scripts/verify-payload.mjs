/**
 * Validate and smoke a staged payload on its target operating system.
 *
 * Usage: node scripts/verify-payload.mjs <win|linux> [payload-dir]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPayloadContract } from './payload-contract.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = process.argv[2]
if (target !== 'win' && target !== 'linux') {
  throw new Error('verify-payload: target must be exactly "win" or "linux"')
}
const hostTarget = process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : undefined
if (hostTarget !== target) {
  throw new Error(`verify-payload: cannot execute a ${target} payload on ${process.platform}`)
}

const payloadDir = resolve(root, process.argv[3] ?? join('.work', `payload-${target}`))
const node = target === 'win' ? join(payloadDir, 'node', 'node.exe') : join(payloadDir, 'node', 'bin', 'node')
const dsh = join(payloadDir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function run(executable, args, label, options = {}) {
  console.log(`verify-payload: ${label}`)
  const result = spawnSync(executable, args, {
    cwd: join(payloadDir, 'app'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `verify-payload: ${label} failed (exit ${String(result.status)})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (output !== '') console.log(output)
}

function smokeNodePty() {
  const requireBase = join(payloadDir, 'app', 'payload-smoke.cjs')
  const script = `
    const { createRequire } = require('node:module');
    const pty = createRequire(${JSON.stringify(requireBase)})('node-pty');
    const marker = 'DSH_NODE_PTY_OK';
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const args = isWindows ? ['/d', '/q', '/k'] : [];
    const terminal = pty.spawn(shell, args, {
      name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
    });
    let output = '';
    let markerSeen = false;
    const timeout = setTimeout(() => {
      console.error('node-pty marker timeout:', output);
      terminal.kill();
      process.exit(1);
    }, 10000);
    terminal.onData((data) => {
      output += data;
      if (!markerSeen && output.includes(marker)) {
        markerSeen = true;
        terminal.write(isWindows ? 'exit\\r' : 'exit\\n');
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (!markerSeen || exitCode !== 0) {
        console.error('node-pty exited before marker:', exitCode, output);
        process.exit(1);
      }
      process.exit(0);
    });
    terminal.write(isWindows ? 'echo ' + marker + '\\r' : "printf '" + marker + "\\n'\\n");
  `
  run(node, ['-e', script], 'node-pty native module smoke')
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

/**
 * One raw HTTP GET against the spawned server. Node's global fetch cannot
 * pass dsh >= 0.1.2-alpha's browser auth: undici follows the 303 to clean
 * `/` but keeps no cookie jar, drops the minted session cookie, and lands
 * on 401. Raw `node:http` with explicit cookie forwarding mirrors exactly
 * what the GUI's Rust readiness probe does.
 */
function probeIndex(urlString, cookie) {
  return new Promise((resolveProbe) => {
    const headers = { accept: 'text/html' }
    if (cookie !== undefined) headers.cookie = cookie
    const request = httpGet(urlString, { headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolveProbe({
          status: response.statusCode,
          setCookie: response.headers['set-cookie'],
          location: response.headers.location,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', () => resolveProbe(null))
    request.setTimeout(2_000, () => {
      request.destroy()
      resolveProbe(null)
    })
  })
}

async function stopProcess(child) {
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.status !== 0 && child.exitCode === null) child.kill()
  } else {
    child.kill('SIGTERM')
  }
  const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])
  child.stdout.destroy()
  child.stderr.destroy()
  if (!stopped && child.exitCode === null) {
    throw new Error(`verify-payload: failed to stop dsh web process ${String(child.pid)}`)
  }
}

async function smokeWeb() {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-payload-smoke-'))
  let output = ''
  const child = spawn(node, [dsh, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: join(payloadDir, 'app'),
    env: { ...process.env, DSH_HOME: isolatedHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-64 * 1024)
  }
  let spawnError
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.once('error', (error) => {
    spawnError = error
  })

  try {
    const deadline = Date.now() + 60_000
    let url
    while (Date.now() < deadline) {
      // dsh >= 0.1.2-alpha prints the browser-auth launch token on the URL
      // (`…/?token=…`); older releases print a bare loopback URL.
      const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/?\S*)/)
      if (match !== null) {
        url = match[1]
        break
      }
      if (child.exitCode !== null) {
        throw new Error(`verify-payload: dsh web exited ${String(child.exitCode)} before readiness\n${output}`)
      }
      if (spawnError !== undefined) throw spawnError
      await delay(50)
    }
    if (url === undefined) throw new Error(`verify-payload: dsh web URL timeout\n${output}`)

    let lastFailure = 'no response'
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`verify-payload: dsh web exited ${String(child.exitCode)}\n${output}`)
      }
      const response = await probeIndex(url)
      let passed = false
      if (response !== null) {
        if (response.status >= 200 && response.status < 300 && response.body.includes('__DSH_BOOT__')) {
          passed = true
        } else if (
          response.status >= 300 && response.status < 400 &&
          Array.isArray(response.setCookie) && response.setCookie.length > 0
        ) {
          // Launch-token exchange: replay the minted session cookie and
          // require the served index with its boot manifest.
          const cookie = response.setCookie.map((value) => value.split(';')[0]).join('; ')
          const followed = await probeIndex(new URL(response.location ?? '/', url).href, cookie)
          if (followed !== null && followed.status >= 200 && followed.status < 300 && followed.body.includes('__DSH_BOOT__')) {
            passed = true
          } else if (followed !== null) {
            lastFailure = `followed HTTP ${String(followed.status)}, boot manifest=${String(followed.body.includes('__DSH_BOOT__'))}`
          } else {
            lastFailure = 'followed request failed'
          }
        } else {
          lastFailure = `HTTP ${String(response.status)}, boot manifest=${String(response.body.includes('__DSH_BOOT__'))}`
        }
      } else {
        lastFailure = 'connection failed'
      }
      if (passed) {
        console.log(`verify-payload: dsh web smoke passed at ${url}`)
        return
      }
      await delay(50)
    }
    throw new Error(`verify-payload: dsh web readiness timeout (${lastFailure})\n${output}`)
  } finally {
    await stopProcess(child)
    rmSync(isolatedHome, { recursive: true, force: true })
  }
}

if (!existsSync(node) || !existsSync(dsh)) throw new Error('verify-payload: staged Node or dsh entry is missing')
const manifest = verifyPayloadContract(payloadDir, target)
console.log(
  `verify-payload: contract passed (${(manifest.bytes / 1024 / 1024).toFixed(1)} MiB, ` +
  `${String(manifest.files)} files, frontend ${manifest.frontend.version})`,
)
run(node, ['--version'], 'bundled Node')
run(node, [dsh, '--version'], 'dsh --version')
smokeNodePty()
await smokeWeb()
