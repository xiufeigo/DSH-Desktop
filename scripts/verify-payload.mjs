/**
 * Validate and smoke a staged payload on its target operating system.
 *
 * Usage: node scripts/verify-payload.mjs <win|linux> [payload-dir]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
      const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/)
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
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
        const body = await response.text()
        if (response.status >= 200 && response.status < 300 && body.includes('__DSH_BOOT__')) {
          console.log(`verify-payload: dsh web smoke passed at ${url}`)
          return
        }
        lastFailure = `HTTP ${String(response.status)}, boot manifest=${String(body.includes('__DSH_BOOT__'))}`
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error)
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
