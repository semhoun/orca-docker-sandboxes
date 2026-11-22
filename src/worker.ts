import { lstat, realpath } from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'
import { runLocal, type Command, type Execution, type Run } from './process'
import { isSandboxName, type ErrorCode, type Result, type Sandbox } from './protocol'

function fail(code: ErrorCode, uncertain = false): Result<never> {
  return { ok: false, error: { code, ...(uncertain ? { uncertain } : {}) } }
}

function ok<T>(value: T): Result<T> { return { ok: true, value } }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

const stableId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const listedName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i
const readOnlySource = '/run/sandbox/source'

function parseList(output: string): Result<Sandbox[]> {
  try {
    const payload: unknown = JSON.parse(output)
    if (!Array.isArray(payload)) return fail('format')
    const rows: Sandbox[] = []
    const names = new Set<string>()
    const ids = new Set<string>()
    for (const item of payload) {
      const row = record(item)
      if (!row || typeof row.name !== 'string' || row.name.length > 63 || !listedName.test(row.name) ||
          typeof row.agent !== 'string' || !/^[a-z0-9._-]{1,80}$/i.test(row.agent) ||
          typeof row.status !== 'string' || (row.id != null && (typeof row.id !== 'string' || !stableId.test(row.id)))) {
        return fail('format')
      }
      const id = typeof row.id === 'string' ? row.id : null
      const name = row.name.toLowerCase()
      if (names.has(name) || (id && ids.has(id.toLowerCase()))) return fail('format')
      names.add(name)
      if (id) ids.add(id.toLowerCase())
      const status = row.status.toLowerCase()
      rows.push({ name: row.name, id, agent: row.agent, status:
        status === 'running' || status === 'stopped' || status === 'starting' || status === 'stopping'
          ? status : 'unknown' })
    }
    return ok(rows)
  } catch {
    return fail('format')
  }
}

function commandError(result: Execution, fallback: ErrorCode, missing: ErrorCode, mayChange = false): Result<never> {
  switch (result.kind) {
    case 'missing': return fail(missing)
    case 'timeout': case 'cancelled': case 'overflow': return fail(result.kind, mayChange)
    case 'spawn': return fail(fallback)
    case 'exit': {
      const diagnostic = `${result.stderr}\n${result.stdout}`
      if (/sbx login|not logged in|(?:docker|registry).{0,60}(?:login required|unauthorized)|authentication required/i.test(diagnostic)) return fail('login', mayChange)
      if (/policy init|policy.{0,60}not initialized|initialize.{0,60}policy/i.test(diagnostic)) return fail('policy', mayChange)
      if (/daemon.{0,60}(?:unavailable|not running)|failed to connect to (?:sandboxd|daemon)|\/dev\/kvm|virtualization.{0,60}(?:unavailable|disabled)/i.test(diagnostic)) return fail('unavailable', mayChange)
      if (fallback === 'create' && /already exists|name.{0,60}already (?:in use|taken)/i.test(diagnostic)) return fail('collision')
      return fail(fallback, mayChange)
    }
  }
}

function succeeded(result: Execution): result is Extract<Execution, { kind: 'exit' }> {
  return result.kind === 'exit' && result.code === 0
}

function absolutePath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && path.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(path)
}

function mountPath(path: unknown): path is string {
  return absolutePath(path) && path !== '/' && path === path.trimEnd() && !/[:\\,]/.test(path)
}

export function makeHandlers(run: Run = runLocal) {
  const active = new Set<string>()
  function invoke(command: Command, args: readonly string[], timeout: number, signal?: AbortSignal) {
    return run(command, args, { timeout, signal }).catch((): Execution => ({ kind: 'spawn' }))
  }

  async function list(signal?: AbortSignal): Promise<Result<Sandbox[]>> {
    const version = await invoke('sbx', ['--version'], 4_000, signal)
    if (!succeeded(version)) return commandError(version, 'version', 'sbxMissing')
    const match = /^sbx version v?(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(version.stdout.trim())
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 48)) return fail('version')
    const result = await invoke('sbx', ['ls', '--json', '--no-input'], 12_000, signal)
    return succeeded(result) ? parseList(result.stdout) : commandError(result, 'unavailable', 'sbxMissing')
  }

  async function locked<T>(name: string, action: () => Promise<Result<T>>): Promise<Result<T>> {
    if (active.has(name)) return fail('busy')
    active.add(name)
    try { return await action() } finally { active.delete(name) }
  }

  async function root(path: unknown, signal?: AbortSignal): Promise<Result<string>> {
    if (!mountPath(path)) return fail('path')
    try {
      const canonical = await realpath(path)
      if (!mountPath(canonical) || !(await lstat(`${canonical}/.git`)).isDirectory()) return fail('path')
      const git = await invoke('git', ['-C', canonical, 'rev-parse', '--path-format=absolute',
        '--is-inside-work-tree', '--show-toplevel', '--git-dir', '--git-common-dir'], 5_000, signal)
      if (!succeeded(git)) return commandError(git, 'path', 'gitMissing')
      const metadata = `${canonical}/.git`
      return git.stdout === `true\n${canonical}\n${metadata}\n${metadata}\n` ? ok(canonical) : fail('path')
    } catch { return fail('path') }
  }

  async function create(input: unknown, signal?: AbortSignal): Promise<Result<{ canonicalPath?: string }>> {
    const value = record(input)
    if (!value || !isSandboxName(value.name) || (value.agent !== 'claude' && value.agent !== 'codex') ||
        (value.mode !== 'none' && value.mode !== 'clone' && value.mode !== 'direct') ||
        (value.preview !== undefined && value.preview !== true) ||
        (value.mode !== 'direct' && (value.preview !== undefined || value.confirmedPath !== undefined)) ||
        (value.mode === 'none' && value.path !== undefined)) return fail('input')
    const { name, agent, mode } = value
    return locked(name, async () => {
      const rows = await list(signal)
      if (!rows.ok) return rows
      if (rows.value.some((row) => row.name.toLowerCase() === name)) return fail('collision')
      let canonical: string | undefined
      if (mode !== 'none') {
        const path = await root(value.path, signal)
        if (!path.ok) return path
        canonical = path.value
      }
      if (mode === 'direct') {
        if (value.preview === true) return ok({ canonicalPath: canonical })
        if (value.confirmedPath !== canonical) return fail('confirm')
      }
      if (signal?.aborted) return fail('cancelled')
      const args = ['create', '--no-input', '--no-progress', ...(mode === 'clone' ? ['--clone'] : []),
        '--name', name, agent, ...(canonical === undefined ? [] : [canonical])]
      const result = await invoke('sbx', args, 80_000, signal)
      return succeeded(result) ? ok({}) : commandError(result, 'create', 'sbxMissing', true)
    })
  }

  async function target(name: string, id: string | null, signal?: AbortSignal): Promise<Result<Sandbox>> {
    const rows = await list(signal)
    if (!rows.ok) return rows
    const found = rows.value.find((row) => row.name === name && row.id === id)
    return found ? ok(found) : fail('stale')
  }

  async function stop(input: unknown, signal?: AbortSignal): Promise<Result<null>> {
    const value = record(input)
    if (!value || !isSandboxName(value.name) || typeof value.id !== 'string' ||
        !stableId.test(value.id) || value.confirmed !== true) return fail('input')
    const { name, id } = value
    return locked(name, async () => {
      const current = await target(name, id, signal)
      if (!current.ok) return current
      if (current.value.status !== 'running') return fail('stale')
      if (signal?.aborted) return fail('cancelled')
      const result = await invoke('sbx', ['stop', '--no-input', id], 30_000, signal)
      return succeeded(result) ? ok(null) : commandError(result, 'stop', 'sbxMissing', true)
    })
  }

  async function testSsh(input: unknown, signal?: AbortSignal): Promise<Result<{ directory: string | null }>> {
    const value = record(input)
    if (!value || !isSandboxName(value.name) || (value.id !== null &&
        (typeof value.id !== 'string' || !stableId.test(value.id)))) return fail('input')
    const { name, id } = value
    return locked(name, async () => {
      const current = await target(name, id, signal)
      if (!current.ok) return current
      if (current.value.status !== 'running' && current.value.status !== 'stopped') return fail('stale')
      if (signal?.aborted) return fail('cancelled')
      const result = await invoke('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
        '-o', 'PermitLocalCommand=no', '-o', 'ControlPath=none', '-l', '_default_user_', `${name}.sbx`, 'pwd'], 30_000, signal)
      if (!succeeded(result)) return commandError(result, 'ssh', 'sshMissing', current.value.status === 'stopped')
      const path = result.stdout.replace(/\r?\n$/, '')
      const normalized = path.replace(/\/{2,}/g, '/')
      const directory = absolutePath(path) && !normalized.split('/').some((part) => part === '..' || part === '.') &&
        normalized !== readOnlySource && !normalized.startsWith(`${readOnlySource}/`) ? normalized : null
      return ok({ directory })
    })
  }

  return { list, create, stop, testSsh }
}

export default function activate(orca: OrcaWorkerApi): void {
  const handlers = makeHandlers()
  orca.panels.handle('sandboxes.list', (_input, { signal }) => handlers.list(signal))
  orca.panels.handle('sandboxes.create', (input, { signal }) => handlers.create(input, signal))
  orca.panels.handle('sandboxes.stop', (input, { signal }) => handlers.stop(input, signal))
  orca.panels.handle('sandboxes.testSsh', (input, { signal }) => handlers.testSsh(input, signal))
}
