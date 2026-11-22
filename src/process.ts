import { spawn } from 'node:child_process'

export type Command = 'sbx' | 'git' | 'ssh'
export type Execution =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'missing' | 'spawn' | 'timeout' | 'overflow' | 'cancelled' }
export type Run = (command: Command, args: readonly string[], options: {
  timeout: number; signal?: AbortSignal
}) => Promise<Execution>

export function localEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }
  for (const key of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return env
}

const outputLimit = 256 * 1024

export const runLocal: Run = (command, args, { signal, timeout }) => new Promise((resolve) => {
  if (signal?.aborted) return resolve({ kind: 'cancelled' })
  const child = spawn(command, args, {
    shell: false, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], env: localEnvironment(process.env)
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let total = 0
  let finished = false

  function finish(result: Execution, interrupt = false) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    if (interrupt) {
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
    }
    resolve(result)
  }

  function cancel() { finish({ kind: 'cancelled' }, true) }
  function collect(destination: Buffer[], chunk: Buffer) {
    if (finished) return
    total += chunk.length
    if (total > outputLimit) finish({ kind: 'overflow' }, true)
    else destination.push(chunk)
  }

  const timer = setTimeout(() => finish({ kind: 'timeout' }, true), timeout)
  signal?.addEventListener('abort', cancel, { once: true })
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
  child.on('error', (error: NodeJS.ErrnoException) => finish({ kind: error.code === 'ENOENT' ? 'missing' : 'spawn' }))
  child.on('close', (code) => finish({
    kind: 'exit', code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')
  }))
})
