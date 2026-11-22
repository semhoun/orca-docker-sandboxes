import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { localEnvironment, runLocal, type Command, type Execution, type Run } from './process'
import type { Result } from './protocol'
import { makeHandlers } from './worker'

const version = 'sbx version v0.54.0 4bec4a5ce093466e54b034146965b143d065dc09\n'
const id = 'b07a88fe-5d03-4fe4-a2cb-93ddc8c0ab19'
const row = { name: 'demo', agent: 'claude', status: 'running', id }
const draft = { name: 'demo', agent: 'claude', mode: 'none' }
const exit = (stdout = '', stderr = '', code = 0): Execution => ({ kind: 'exit', code, stdout, stderr })
const error = (result: Result<unknown>) => {
  assert.equal(result.ok, false)
  if (!result.ok) return result.error
  throw new Error('Expected failure')
}

function fake(options: { json?: string; version?: Execution; action?: Run } = {}) {
  const calls: [Command, ...string[]][] = []
  const run: Run = async (command, args, config) => {
    calls.push([command, ...args])
    if (command === 'sbx' && args[0] === '--version') return options.version ?? exit(version)
    if (command === 'sbx' && args[0] === 'ls') return exit(options.json ?? '[]')
    return options.action ? options.action(command, args, config) : exit()
  }
  return { calls, handlers: makeHandlers(run) }
}

test('reads sbx 0.54.0 array, preserves unknown state, and discards private fields', async () => {
  assert.deepEqual(await fake().handlers.list(), { ok: true, value: [] })
  const { calls, handlers } = fake({ json: JSON.stringify([{ ...row, status: 'surprise', secret: 'private' }]) })
  assert.deepEqual(await handlers.list(), { ok: true, value: [{ ...row, status: 'unknown' }] })
  assert.deepEqual(calls, [['sbx', '--version'], ['sbx', 'ls', '--json', '--no-input']])
  for (const json of ['broken', '{"sandboxes":[]}', '[{"name":"demo"}]', JSON.stringify([row, row])]) {
    assert.equal(error(await fake({ json }).handlers.list()).code, 'format')
  }
})

test('rejects a missing or unsupported CLI without trying a mutation', async () => {
  for (const [version, code] of [[{ kind: 'missing' }, 'sbxMissing'], [exit('sbx version v0.47.9\n'), 'version']] as const) {
    const { calls, handlers } = fake({ version })
    assert.equal(error(await handlers.create(draft)).code, code)
    assert.deepEqual(calls, [['sbx', '--version']])
  }
})

test('mountless create is explicit and rejects collisions and invalid parameters', async () => {
  const { handlers, calls } = fake()
  for (const input of [{ ...draft, name: '--cloud' }, { ...draft, name: 'bad\n' }, { ...draft, agent: 'shell' }, { ...draft, path: '.' }]) {
    assert.equal(error(await handlers.create(input)).code, 'input')
  }
  assert.equal(calls.length, 0)
  assert.deepEqual(await handlers.create(draft), { ok: true, value: {} })
  assert.deepEqual(calls.at(-1), ['sbx', 'create', '--no-input', '--no-progress', '--name', 'demo', 'claude'])
  const duplicate = fake({ json: JSON.stringify([row]) })
  assert.equal(error(await duplicate.handlers.create(draft)).code, 'collision')
  assert.equal(duplicate.calls.length, 2)
})

test('clone and direct are explicit; canonical paths with spaces stay a single argv item', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'orca-sbx-git-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(await realpath(parent), 'repo with spaces')
  const alias = join(parent, 'alias')
  const linked = join(parent, 'linked')
  await mkdir(join(root, '.git'), { recursive: true })
  await symlink(root, alias)
  await mkdir(linked)
  await writeFile(join(linked, '.git'), `gitdir: ${root}/.git/worktrees/linked\n`)
  const { handlers, calls } = fake({ action: async (command, args) => {
    if (command !== 'git') return exit()
    assert.deepEqual(args, ['-C', root, 'rev-parse', '--path-format=absolute', '--is-inside-work-tree',
      '--show-toplevel', '--git-dir', '--git-common-dir'])
    return exit(`true\n${root}\n${root}/.git\n${root}/.git\n`)
  } })
  const direct = { ...draft, mode: 'direct', path: alias }
  assert.deepEqual(await handlers.create({ ...direct, preview: true }), { ok: true, value: { canonicalPath: root } })
  assert.equal(error(await handlers.create({ ...direct, confirmedPath: alias })).code, 'confirm')
  assert.equal(error(await handlers.create({ ...direct, path: linked, confirmedPath: linked })).code, 'path')
  assert.equal(error(await handlers.create({ ...direct, path: `${root}:ro`, confirmedPath: root })).code, 'path')
  assert.equal(calls.some(([, verb]) => verb === 'create'), false)
  for (const mode of ['clone', 'direct']) {
    const confirmation = mode === 'direct' ? { confirmedPath: root } : {}
    assert.deepEqual(await handlers.create({ ...draft, mode, path: alias, agent: 'codex', ...confirmation }), { ok: true, value: {} })
    assert.deepEqual(calls.at(-1), ['sbx', 'create', '--no-input', '--no-progress',
      ...(mode === 'clone' ? ['--clone'] : []), '--name', 'demo', 'codex', root])
  }
})

test('stop requires confirmation and a fresh identity, and never forces', async () => {
  const { handlers, calls } = fake({ json: JSON.stringify([row]) })
  assert.equal(error(await handlers.stop({ ...row, confirmed: false })).code, 'input')
  assert.equal(error(await handlers.stop({ ...row, id: 'aa7a88fe-5d03-4fe4-a2cb-93ddc8c0ab19', confirmed: true })).code, 'stale')
  assert.equal(calls.some(([, verb]) => verb === 'stop'), false)
  assert.deepEqual(await handlers.stop({ ...row, confirmed: true }), { ok: true, value: null })
  assert.deepEqual(calls.at(-1), ['sbx', 'stop', '--no-input', id])
})

test('duplicate actions are blocked and timeout does not trigger a retry', async () => {
  let release!: (result: Execution) => void
  const pending = new Promise<Execution>((resolve) => { release = resolve })
  const { handlers, calls } = fake({ action: () => pending })
  const first = handlers.create(draft)
  assert.equal(error(await handlers.create(draft)).code, 'busy')
  release({ kind: 'timeout' })
  assert.equal(error(await first).uncertain, true)
  assert.equal(calls.filter(([, verb]) => verb === 'create').length, 1)
})

test('SSH runs fixed pwd with strict host checking; never returns the read-only source', async () => {
  const { handlers, calls } = fake({ json: JSON.stringify([{ ...row, status: 'stopped' }]), action: async () => exit('/run//sandbox/source/project\n') })
  assert.deepEqual(await handlers.testSsh(row), { ok: true, value: { directory: null } })
  assert.deepEqual(calls.at(-1), ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ControlPath=none', '-l', '_default_user_', 'demo.sbx', 'pwd'])
  const mounted = fake({ json: JSON.stringify([row]), action: async () => exit('/home/agent/my project\n') })
  assert.deepEqual(await mounted.handlers.testSsh(row), { ok: true, value: { directory: '/home/agent/my project' } })
})

test('auth, policy, and SSH errors do not echo CLI output', async () => {
  for (const [failure, code] of [['Run sbx login', 'login'], ['sbx policy init', 'policy'], ['Host key verification failed', 'ssh']]) {
    const { handlers } = fake({ json: JSON.stringify([row]), action: async () => exit('', `${failure}: private-token`, 255) })
    const diagnostic = error(await handlers.testSsh(row))
    assert.deepEqual(diagnostic, { code })
  }
})

test('subprocess does not receive credentials or shell startup overrides', async () => {
  assert.deepEqual(localEnvironment({ PATH: '/usr/bin', HOME: '/home/demo', OPENAI_API_KEY: 'private',
    ANTHROPIC_API_KEY: 'private', BASH_ENV: 'private', GIT_DIR: 'private' }), {
    PATH: '/usr/bin', HOME: '/home/demo', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0'
  })
  const result = await runLocal('git', ['-c', 'alias.probe=!exit 0', '--version'], { timeout: 1_000 })
  assert.equal(result.kind, 'exit')
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await runLocal('sbx', ['--version'], { timeout: 1_000, signal: controller.signal }), { kind: 'cancelled' })
})
