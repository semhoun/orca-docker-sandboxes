import {
  atom, Badge, Button, Callout, Card, Code, Collapsible, EmptyState, env, Heading, Input,
  KeyValue, List, ListItem, plugin, read, Row, Select, set, Spinner, Stack, Text, update,
  type PanelContext
} from 'orca'
import { isSandboxName, type Agent, type Mode, type Result, type Sandbox } from './protocol'
import { messages, type Locale } from './panel-messages'
import { workerMessage } from './worker-messages'

const LIST_TIMEOUT = 25_000
const CREATE_TIMEOUT = 120_000
const ACTION_TIMEOUT = 55_000
const READ_ONLY_SOURCE = '/run/sandbox/source'

type Draft = { name: string; agent: Agent; mode: Mode; path: string }
type Target = Pick<Sandbox, 'name' | 'id'>
type Inventory = { rows: Sandbox[]; fresh: boolean }
type Notice = { tone: 'danger' | 'success' | 'warning'; text: string }
type Confirmation =
  | { kind: 'direct'; draft: Draft; canonicalPath: string }
  | { kind: 'stop'; name: string; id: string }

const initialDraft: Draft = { name: '', agent: 'claude', mode: 'none', path: '' }
const draft = atom(initialDraft)
const inventory = atom<Inventory>({ rows: [], fresh: false })
const pending = atom<string | null>(null)
const listError = atom<string | null>(null)
const notice = atom<Notice | null>(null)
const selected = atom<Target | null>(null)
const confirmation = atom<Confirmation | null>(null)
const ssh = atom<{ target: Target; directory: string | null } | null>(null)
let lifetime: AbortSignal | undefined

const agents = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
]
const modes = ['none', 'clone', 'direct'] as const
const statusTones = {
  running: 'success', stopped: 'neutral', starting: 'warning', stopping: 'warning', unknown: 'warning'
} as const

function currentLocale(): Locale {
  return env.locale.toLowerCase().split('-')[0] === 'fr' ? 'fr' : 'en'
}

function sameTarget(a: Target, b: Target | null): boolean {
  return b !== null && a.name === b.name && a.id === b.id
}

function fresh(snapshot: Inventory): boolean {
  return !lifetime?.aborted && !read(pending) && snapshot.fresh && snapshot === read(inventory)
}

function validDraft(value: Draft, rows: Sandbox[]): boolean {
  return isSandboxName(value.name) && !rows.some((row) => row.name === value.name) &&
    (value.mode === 'none' || value.path.trim() !== '')
}

function editDraft(change: Partial<Draft>): void {
  if (read(pending) || lifetime?.aborted) return
  set(confirmation, null)
  update(draft, (value) => ({ ...value, ...change }))
}

function rejected<T>(result: Result<T>, locale: Locale, fallback: string): result is Extract<Result<T>, { ok: false }> {
  if (result.ok) return false
  const t = messages[locale]
  const reason = workerMessage(locale, result.error.code) ?? fallback
  set(notice, result.error.uncertain ? {
    tone: 'warning',
    text: `${reason} ${t.uncertainHint} ${t.retryHint}`
  } : { tone: 'danger', text: reason })
  return true
}

async function refresh(): Promise<boolean> {
  if (lifetime?.aborted) return false
  const locale = currentLocale()
  const t = messages[locale]
  set(pending, t.refreshing)
  set(listError, null)
  try {
    const result = await plugin.request('sandboxes.list', {}, { timeoutMs: LIST_TIMEOUT })
    if (lifetime?.aborted) return false
    if (!result.ok) {
      set(listError, workerMessage(locale, result.error.code) ?? t.listError)
      return false
    }
    const current = read(selected)
    if (current && !result.value.some((row) => sameTarget(row, current))) set(selected, null)
    set(inventory, { rows: result.value, fresh: true })
    return true
  } catch {
    if (!lifetime?.aborted) set(listError, t.listTransport)
    return false
  }
}

async function reload(): Promise<void> {
  set(confirmation, null)
  set(ssh, null)
  update(inventory, (value) => ({ ...value, fresh: false }))
  try {
    await refresh()
  } finally {
    if (!lifetime?.aborted) set(pending, null)
  }
}

export function setup(ctx: PanelContext): void {
  lifetime = ctx.signal
  void reload()
}

async function attempt(
  label: string,
  operation: () => Promise<(() => void) | void>,
  transportFailure: Notice
): Promise<void> {
  // Lock before the first await, including during the list reconciliation that follows each request.
  set(pending, label)
  set(notice, null)
  set(confirmation, null)
  set(ssh, null)
  update(inventory, (value) => ({ ...value, fresh: false }))
  let afterRefresh: (() => void) | void = undefined
  try {
    afterRefresh = await operation()
  } catch {
    if (!lifetime?.aborted) set(notice, transportFailure)
  } finally {
    if (!lifetime?.aborted) {
      try {
        if (await refresh()) afterRefresh?.()
      } finally {
        if (!lifetime?.aborted) set(pending, null)
      }
    }
  }
}

function uncertain(text: string, retryHint: string): Notice {
  return { tone: 'warning', text: `${text} ${retryHint}` }
}

function create(snapshot: Inventory, expected?: Confirmation): void {
  if (!fresh(snapshot) || (read(confirmation) ?? undefined) !== expected) return
  const value = read(draft)
  if (!validDraft(value, snapshot.rows)) return
  const locale = currentLocale()
  const t = messages[locale]
  const { name, agent, mode, path } = value
  const input = mode === 'none' ? { name, agent, mode } : { name, agent, mode, path }
  if (mode === 'direct' && !expected) {
    void attempt(t.verifyingPath, async () => {
      const result = await plugin.request('sandboxes.create', { ...input, preview: true }, { timeoutMs: CREATE_TIMEOUT })
      if (lifetime?.aborted || rejected(result, locale, t.pathPreviewError)) return
      const canonicalPath = result.value.canonicalPath
      if (!canonicalPath) {
        set(notice, { tone: 'danger', text: t.pathMissing })
        return
      }
      return () => {
        if (read(draft) === value && validDraft(value, read(inventory).rows)) {
          set(confirmation, { kind: 'direct', draft: value, canonicalPath })
        }
      }
    }, { tone: 'danger', text: t.pathTransport })
    return
  }
  if (mode === 'direct' && (expected?.kind !== 'direct' || expected.draft !== value)) return
  const confirmedInput = expected?.kind === 'direct' ? { ...input, confirmedPath: expected.canonicalPath } : input
  void attempt(t.creating, async () => {
    const result = await plugin.request('sandboxes.create', confirmedInput, { timeoutMs: CREATE_TIMEOUT })
    if (lifetime?.aborted || rejected(result, locale, t.createError)) return
    set(draft, initialDraft)
    set(notice, { tone: 'success', text: t.createSuccess(name) })
    return () => {
      const row = read(inventory).rows.find((item) => item.name === name)
      if (row) set(selected, row)
    }
  }, uncertain(t.createTransport, t.retryHint))
}

function transitioning(row: Sandbox): boolean {
  return row.status === 'starting' || row.status === 'stopping'
}

function stop(snapshot: Inventory, row: Sandbox, expected?: Confirmation): void {
  if (!fresh(snapshot) || !sameTarget(row, read(selected)) || !row.id || transitioning(row) || row.status === 'stopped') return
  if (!expected) {
    if (!read(confirmation)) set(confirmation, { kind: 'stop', name: row.name, id: row.id })
    return
  }
  if (read(confirmation) !== expected || expected.kind !== 'stop' || !sameTarget(row, expected)) return
  const { name, id } = expected
  const locale = currentLocale()
  const t = messages[locale]
  void attempt(t.stopping, async () => {
    const result = await plugin.request('sandboxes.stop', { name, id, confirmed: true }, { timeoutMs: ACTION_TIMEOUT })
    if (lifetime?.aborted) return
    if (rejected(result, locale, t.stopError)) {
      const failure = read(notice)
      if (failure?.tone === 'danger') set(notice, { ...failure, text: `${failure.text} ${t.stopRetry}` })
      return
    }
    set(notice, { tone: 'success', text: t.stopSuccess(name) })
  }, uncertain(t.stopTransport, t.retryHint))
}

function testSsh(snapshot: Inventory, row: Sandbox): void {
  if (!fresh(snapshot) || !sameTarget(row, read(selected)) || transitioning(row) || read(confirmation)) return
  const target = { name: row.name, id: row.id }
  const locale = currentLocale()
  const t = messages[locale]
  void attempt(t.testingSsh, async () => {
    const result = await plugin.request('sandboxes.testSsh', target, { timeoutMs: ACTION_TIMEOUT })
    if (lifetime?.aborted) return
    if (rejected(result, locale, t.sshError)) return
    set(notice, { tone: 'success', text: t.sshSuccess(row.name) })
    const path = result.value.directory
    const directory = path === READ_ONLY_SOURCE || path?.startsWith(`${READ_ONLY_SOURCE}/`) ? null : path
    return () => {
      if (sameTarget(target, read(selected))) set(ssh, { target, directory })
    }
  }, uncertain(t.sshTransport, t.retryHint))
}

function choose(snapshot: Inventory, row: Sandbox): void {
  if (!fresh(snapshot)) return
  set(selected, sameTarget(row, read(selected)) ? null : row)
  set(confirmation, null)
  set(ssh, null)
}

function cancel(expected: Confirmation): void {
  if (!read(pending) && read(confirmation) === expected) set(confirmation, null)
}

function SandboxDetails({ row, snapshot }: { row: Sandbox; snapshot: Inventory }) {
  const t = messages[currentLocale()]
  const confirm = read(confirmation)
  const discovery = read(ssh)
  const test = discovery && sameTarget(row, discovery.target) ? discovery : null
  const active = fresh(snapshot) && !transitioning(row)

  return (
    <Card title={t.connection(row.name)}>
      <Stack gap="sm">
        <KeyValue label={t.sshSettings} items={[
          { label: t.host, value: `${row.name}.sbx`, code: true },
          { label: t.username, value: '_default_user_', code: true },
          { label: t.port, value: t.defaultPort },
          { label: t.identity, value: t.noIdentity }
        ]} />
        {test ? test.directory ? (
          <Text>{t.directoryFound} <Code>{test.directory}</Code></Text>
        ) : (
          <Text tone="warning">{t.directoryMissing}</Text>
        ) : null}
        <Row gap="sm" wrap>
          <Button icon="terminal" disabled={!active || !!confirm} onPress={() => testSsh(snapshot, row)}>{t.testSsh}</Button>
          <Button icon="stop" variant="outline" tone="danger" disabled={!active || !row.id || row.status === 'stopped' || !!confirm} onPress={() => stop(snapshot, row)}>{t.stop}</Button>
        </Row>
        <Text muted size="sm">{t.sshHint}</Text>
        {!row.id ? <Text muted size="sm">{t.stopUnavailable}</Text> : null}
        {confirm?.kind === 'stop' && sameTarget(row, confirm) ? (
          <Callout title={t.stopTitle(row.name)} tone="danger">
            <Stack gap="sm">
              <Text>{t.stopWarning}</Text>
              <Row gap="sm" wrap>
                <Button variant="outline" onPress={() => cancel(confirm)}>{t.cancel}</Button>
                <Button tone="danger" disabled={!active} onPress={() => stop(snapshot, row, confirm)}>{t.confirmStop}</Button>
              </Row>
            </Stack>
          </Callout>
        ) : null}
        <Collapsible title={t.openProject} description={t.openProjectHint}>
          <Stack gap="sm">
            <Text weight="semibold">{t.addTarget}</Text>
            <Text>{t.addTargetHelp}</Text>
            <Text weight="semibold">{t.openRepo}</Text>
            <Text>{t.openRepoHelp}</Text>
            <Text weight="semibold">{t.runWorktree}</Text>
            <Text>{t.runWorktreeHelp}</Text>
            <Text muted>{t.reconnectHint}</Text>
          </Stack>
        </Collapsible>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const t = messages[currentLocale()]
  const snapshot = read(inventory)
  const busy = read(pending)
  const failure = read(listError)
  const message = read(notice)
  const value = read(draft)
  const confirm = read(confirmation)
  const current = read(selected)
  const row = snapshot.rows.find((item) => sameTarget(item, current))
  const nameInvalid = value.name !== '' && !isSandboxName(value.name)
  const collision = snapshot.fresh && snapshot.rows.some((item) => item.name === value.name)
  const canCreate = fresh(snapshot) && validDraft(value, snapshot.rows)

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Row justify="between" gap="sm" wrap>
          <Heading level={1}>{t.heading}</Heading>
          <Button icon="refresh" variant="outline" disabled={!!busy} onPress={() => { if (!read(pending)) void reload() }}>{t.refresh}</Button>
        </Row>
        {busy ? <Spinner label={busy} /> : null}
        {failure ? (
          <Callout tone="danger" title={t.listErrorTitle}>
            <Text>{failure} {t.refreshHint}</Text>
          </Callout>
        ) : null}
        {message ? <Callout tone={message.tone}><Text>{message.text}</Text></Callout> : null}
        {!snapshot.fresh && snapshot.rows.length ? <Text muted>{t.staleList}</Text> : null}
        {snapshot.rows.length ? (
          <List label={t.listLabel}>
            {snapshot.rows.map((item) => (
              <ListItem key={item.name} title={item.name} current={sameTarget(item, current)} disabled={!fresh(snapshot)}
                description={agents.find((agent) => agent.value === item.agent)?.label ?? item.agent}
                onPress={() => choose(snapshot, item)}>
                <Badge tone={statusTones[item.status]}>{t.status[item.status]}</Badge>
              </ListItem>
            ))}
          </List>
        ) : snapshot.fresh ? (
          <EmptyState title={t.emptyTitle} description={t.emptyHint} />
        ) : null}
        {row ? <SandboxDetails key={JSON.stringify([row.name, row.id])} row={row} snapshot={snapshot} /> : null}
      </Stack>

      <Card title={t.createTitle} description={t.createHint}>
        <Stack gap="sm">
          <Input label={t.name} value={value.name} onChange={(name) => editDraft({ name })} maxLength={63}
            placeholder={t.nameExample} disabled={!!busy} invalid={nameInvalid || collision} />
          {nameInvalid ? <Text tone="danger">{t.nameInvalid}</Text> : null}
          {collision ? <Text tone="danger">{t.nameTaken}</Text> : null}
          <Select label={t.agent} value={value.agent} options={agents} disabled={!!busy}
            onChange={(agent) => { if (agent === 'claude' || agent === 'codex') editDraft({ agent }) }} />
          <Select label={t.sharingMode} value={value.mode} options={modes.map((mode) => ({ value: mode, label: t.modes[mode].label }))} disabled={!!busy}
            onChange={(mode) => { if (mode === 'none' || mode === 'clone' || mode === 'direct') editDraft({ mode }) }} />
          <Text muted>{t.modes[value.mode].help}</Text>
          {value.mode !== 'none' ? (
            <Stack gap="xs">
              <Input label={t.repoPath} placeholder={t.pathExample} maxLength={4096} value={value.path}
                onChange={(path) => editDraft({ path })} disabled={!!busy} />
              <Text muted size="sm">{t.pathHint}</Text>
            </Stack>
          ) : null}
          {confirm?.kind === 'direct' ? (
            <Callout tone="warning" title={t.mountTitle(confirm.draft.name)}>
              <Stack gap="sm">
                <Text>{t.canonicalPath} <Code>{confirm.canonicalPath}</Code></Text>
                <Text>{t.mountWarning}</Text>
                <Row gap="sm" wrap>
                  <Button variant="outline" onPress={() => cancel(confirm)}>{t.cancel}</Button>
                  <Button tone="danger" disabled={!canCreate} onPress={() => create(snapshot, confirm)}>{t.confirmMount}</Button>
                </Row>
              </Stack>
            </Callout>
          ) : (
            <Button icon="add" disabled={!canCreate || !!confirm} onPress={() => create(snapshot)}>
              {value.mode === 'direct' ? t.verifyPath : t.create}
            </Button>
          )}
        </Stack>
      </Card>

      <Collapsible title={t.troubleshooting} description={t.troubleshootingHint}>
        <Stack gap="sm">
          <Text>{t.setupHelp}</Text>
          <Text>{t.sshHelp}</Text>
          <Text>{t.agentHelp}</Text>
          <Text>{t.removeHelp}</Text>
        </Stack>
      </Collapsible>
    </Stack>
  )
}
