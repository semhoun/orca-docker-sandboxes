import {
  atom, Badge, Button, Callout, Card, Code, Collapsible, EmptyState, Heading, Input,
  KeyValue, List, ListItem, plugin, read, Row, Select, set, Spinner, Stack, Text, update,
  type PanelContext
} from 'orca'
import { isSandboxName, type Agent, type Mode, type Result, type Sandbox } from './protocol'

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
const pending = atom<string | null>('Lecture de la liste…')
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
const modes: { value: Mode; label: string; help: string }[] = [
  { value: 'none', label: 'Sans montage', help: 'Aucun dossier hôte partagé. Clonez votre dépôt dans la microVM.' },
  { value: 'clone', label: 'Clone du dépôt local', help: 'Docker crée un clone dans la microVM. La source hôte est accessible en lecture seule et Git peut ajouter un remote sandbox-<nom>.' },
  { value: 'direct', label: 'Montage direct', help: 'Les écritures dans le dossier monté modifient le checkout hôte. Ouvrez ce checkout à distance ; pour des worktrees indépendants, choisissez Sans montage ou Clone du dépôt local.' }
]
const statuses = {
  running: { label: 'En cours', tone: 'success' },
  stopped: { label: 'Arrêtée', tone: 'neutral' },
  starting: { label: 'Démarre', tone: 'warning' },
  stopping: { label: 'S’arrête', tone: 'warning' },
  unknown: { label: 'État inconnu', tone: 'warning' }
} as const

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

function workerMessage(error: Extract<Result<unknown>, { ok: false }>['error'], fallback: string): string {
  // Result messages are bounded, localized diagnostics supplied by the worker, not IPC errors.
  return error.message || fallback
}

function rejected<T>(result: Result<T>, fallback: string): result is Extract<Result<T>, { ok: false }> {
  if (result.ok) return false
  const reason = workerMessage(result.error, fallback)
  set(notice, result.error.uncertain ? {
    tone: 'warning',
    text: `${reason} L’action a peut-être abouti. Vérifiez la liste avant de réessayer.`
  } : { tone: 'danger', text: reason })
  return true
}

async function refresh(): Promise<boolean> {
  if (lifetime?.aborted) return false
  set(pending, 'Actualisation de la liste…')
  set(listError, null)
  try {
    const result = await plugin.request('sandboxes.list', {}, { timeoutMs: LIST_TIMEOUT })
    if (lifetime?.aborted) return false
    if (!result.ok) {
      set(listError, workerMessage(result.error, 'Docker n’a pas fourni la liste des sandboxes.'))
      return false
    }
    const current = read(selected)
    if (current && !result.value.some((row) => sameTarget(row, current))) set(selected, null)
    set(inventory, { rows: result.value, fresh: true })
    return true
  } catch {
    if (!lifetime?.aborted) set(listError, 'Orca n’a pas pu lire la liste des sandboxes.')
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

function uncertain(text: string): Notice {
  return { tone: 'warning', text: `${text} Vérifiez la liste avant de réessayer.` }
}

function create(snapshot: Inventory, expected?: Confirmation): void {
  if (!fresh(snapshot) || (read(confirmation) ?? undefined) !== expected) return
  const value = read(draft)
  if (!validDraft(value, snapshot.rows)) return
  const { name, agent, mode, path } = value
  const input = mode === 'none' ? { name, agent, mode } : { name, agent, mode, path }
  if (mode === 'direct' && !expected) {
    void attempt('Vérification du chemin local…', async () => {
      const result = await plugin.request('sandboxes.create', { ...input, preview: true }, { timeoutMs: CREATE_TIMEOUT })
      if (lifetime?.aborted || rejected(result, 'Le chemin local n’a pas pu être vérifié.')) return
      const canonicalPath = result.value.canonicalPath
      if (!canonicalPath) {
        set(notice, { tone: 'danger', text: 'Orca n’a pas reçu de chemin canonique. Aucun montage n’a été demandé.' })
        return
      }
      return () => {
        if (read(draft) === value && validDraft(value, read(inventory).rows)) {
          set(confirmation, { kind: 'direct', draft: value, canonicalPath })
        }
      }
    }, { tone: 'danger', text: 'Orca n’a pas pu vérifier le chemin local. Aucun montage n’a été demandé.' })
    return
  }
  if (mode === 'direct' && (expected?.kind !== 'direct' || expected.draft !== value)) return
  const confirmedInput = expected?.kind === 'direct' ? { ...input, confirmedPath: expected.canonicalPath } : input
  void attempt('Création de la sandbox…', async () => {
    const result = await plugin.request('sandboxes.create', confirmedInput, { timeoutMs: CREATE_TIMEOUT })
    if (lifetime?.aborted || rejected(result, 'La création a échoué.')) return
    set(draft, initialDraft)
    set(notice, { tone: 'success', text: `Sandbox ${name} créée. Ouvrez ses détails pour préparer la connexion SSH.` })
    return () => {
      const row = read(inventory).rows.find((item) => item.name === name)
      if (row) set(selected, row)
    }
  }, uncertain('Orca n’a pas reçu la réponse à la création. La sandbox existe peut-être déjà.'))
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
  void attempt('Arrêt de la sandbox…', async () => {
    const result = await plugin.request('sandboxes.stop', { name, id, confirmed: true }, { timeoutMs: ACTION_TIMEOUT })
    if (lifetime?.aborted) return
    if (rejected(result, 'L’arrêt a échoué.')) {
      const failure = read(notice)
      if (failure?.tone === 'danger') set(notice, { ...failure, text: `${failure.text} Si des sessions sont ouvertes, fermez-les avant de réessayer. Ne forcez pas l’arrêt.` })
      return
    }
    set(notice, { tone: 'success', text: `Sandbox ${name} arrêtée. L’arrêt ne supprime pas ses fichiers.` })
  }, uncertain('Orca n’a pas reçu la réponse à l’arrêt. La sandbox est peut-être déjà arrêtée.'))
}

function testSsh(snapshot: Inventory, row: Sandbox): void {
  if (!fresh(snapshot) || !sameTarget(row, read(selected)) || transitioning(row) || read(confirmation)) return
  const target = { name: row.name, id: row.id }
  void attempt('Test OpenSSH…', async () => {
    const result = await plugin.request('sandboxes.testSsh', target, { timeoutMs: ACTION_TIMEOUT })
    if (lifetime?.aborted) return
    if (rejected(result, 'Le test OpenSSH a échoué.')) return
    set(notice, { tone: 'success', text: `OpenSSH a répondu pour ${row.name}. Testez aussi la connexion dans Orca.` })
    const path = result.value.directory
    const directory = path === READ_ONLY_SOURCE || path?.startsWith(`${READ_ONLY_SOURCE}/`) ? null : path
    return () => {
      if (sameTarget(target, read(selected))) set(ssh, { target, directory })
    }
  }, uncertain('Orca n’a pas reçu la réponse au test SSH. La sandbox a peut-être démarré.'))
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
  const confirm = read(confirmation)
  const discovery = read(ssh)
  const test = discovery && sameTarget(row, discovery.target) ? discovery : null
  const active = fresh(snapshot) && !transitioning(row)

  return (
    <Card title={`Connexion à ${row.name}`}>
      <Stack gap="sm">
        <KeyValue label="Paramètres SSH dans Orca" items={[
          { label: 'Hôte', value: `${row.name}.sbx`, code: true },
          { label: 'Utilisateur', value: '_default_user_', code: true },
          { label: 'Port', value: 'Par défaut' },
          { label: 'Fichier d’identité', value: 'Aucun' }
        ]} />
        {test ? test.directory ? (
          <Text>Répertoire distant trouvé : <Code>{test.directory}</Code></Text>
        ) : (
          <Text tone="warning">OpenSSH a répondu, mais aucun répertoire de travail exploitable n’a été trouvé. Repérez le checkout accessible en écriture dans la sandbox.</Text>
        ) : null}
        <Row gap="sm" wrap>
          <Button icon="terminal" disabled={!active || !!confirm} onPress={() => testSsh(snapshot, row)}>Tester SSH</Button>
          <Button icon="stop" variant="outline" tone="danger" disabled={!active || !row.id || row.status === 'stopped' || !!confirm} onPress={() => stop(snapshot, row)}>Arrêter</Button>
        </Row>
        <Text muted size="sm">Tester SSH peut démarrer une sandbox arrêtée. Ce test OpenSSH ne valide pas le runtime Orca.</Text>
        {!row.id ? <Text muted size="sm">Arrêt indisponible : Docker n’a pas fourni d’identifiant stable.</Text> : null}
        {confirm?.kind === 'stop' && sameTarget(row, confirm) ? (
          <Callout title={`Arrêter ${row.name} ?`} tone="danger">
            <Stack gap="sm">
              <Text>Tous les agents et terminaux de cette sandbox peuvent être interrompus. Ses fichiers sont conservés.</Text>
              <Row gap="sm" wrap>
                <Button variant="outline" onPress={() => cancel(confirm)}>Annuler</Button>
                <Button tone="danger" disabled={!active} onPress={() => stop(snapshot, row, confirm)}>Confirmer l’arrêt</Button>
              </Row>
            </Stack>
          </Callout>
        ) : null}
        <Collapsible title="Ouvrir le projet dans Orca" description="Cible SSH, dépôt et worktrees">
          <Stack gap="sm">
            <Text weight="semibold">1. Ajouter la cible SSH</Text>
            <Text>Dans Settings → SSH → Add Target, recopiez les paramètres ci-dessus. Cliquez sur Test, puis Save. La première connexion installe le runtime géré d’Orca.</Text>
            <Text weight="semibold">2. Ouvrir le dépôt distant</Text>
            <Text>Ajoutez le dépôt existant sur cette cible. Sans montage, clonez d’abord votre dépôt dans la sandbox, généralement sous <Code>/home/agent/workspace</Code>. En mode clone, ouvrez le clone accessible en écriture, pas la source en lecture seule.</Text>
            <Text weight="semibold">3. Choisir où tourne le worktree</Text>
            <Text>Sans montage ou en mode clone, sélectionnez la cible sous Run on. Les worktrees de la sandbox partagent outils, réseau et services. En montage direct, ouvrez plutôt le checkout existant.</Text>
            <Text muted>Une reconnexion Orca peut redémarrer la sandbox. Désactivez Reconnect on launch sur la cible SSH si vous souhaitez la laisser arrêtée.</Text>
          </Stack>
        </Collapsible>
      </Stack>
    </Card>
  )
}

export default function Panel() {
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
          <Heading level={1}>Sandboxes locales</Heading>
          <Button icon="refresh" variant="outline" disabled={!!busy} onPress={() => { if (!read(pending)) void reload() }}>Actualiser</Button>
        </Row>
        {busy ? <Spinner label={busy} /> : null}
        {failure ? (
          <Callout tone="danger" title="Liste non actualisée">
            <Text>{failure} Utilisez Actualiser pour réactiver les actions.</Text>
          </Callout>
        ) : null}
        {message ? <Callout tone={message.tone}><Text>{message.text}</Text></Callout> : null}
        {!snapshot.fresh && snapshot.rows.length ? <Text muted>Dernière liste connue. Actions désactivées.</Text> : null}
        {snapshot.rows.length ? (
          <List label="Sandboxes Docker">
            {snapshot.rows.map((item) => (
              <ListItem key={item.name} title={item.name} current={sameTarget(item, current)} disabled={!fresh(snapshot)}
                description={agents.find((agent) => agent.value === item.agent)?.label ?? item.agent}
                onPress={() => choose(snapshot, item)}>
                <Badge tone={statuses[item.status].tone}>{statuses[item.status].label}</Badge>
              </ListItem>
            ))}
          </List>
        ) : snapshot.fresh ? (
          <EmptyState title="Aucune sandbox locale" description="Créez une sandbox pour préparer un projet distant dans Orca." />
        ) : null}
        {row ? <SandboxDetails key={JSON.stringify([row.name, row.id])} row={row} snapshot={snapshot} /> : null}
      </Stack>

      <Card title="Créer une sandbox" description="Le mode de partage est fixé à la création.">
        <Stack gap="sm">
          <Input label="Nom" value={value.name} onChange={(name) => editDraft({ name })} maxLength={63}
            placeholder="mon-projet" disabled={!!busy} invalid={nameInvalid || collision} />
          {nameInvalid ? <Text tone="danger">Utilisez de 2 à 63 lettres ASCII minuscules, chiffres ou tirets internes. Le nom « default » est réservé.</Text> : null}
          {collision ? <Text tone="danger">Une sandbox porte déjà ce nom. Choisissez un autre nom.</Text> : null}
          <Select label="Agent" value={value.agent} options={agents} disabled={!!busy}
            onChange={(agent) => { if (agent === 'claude' || agent === 'codex') editDraft({ agent }) }} />
          <Select label="Mode de partage" value={value.mode} options={modes.map(({ value, label }) => ({ value, label }))} disabled={!!busy}
            onChange={(mode) => { if (mode === 'none' || mode === 'clone' || mode === 'direct') editDraft({ mode }) }} />
          <Text muted>{modes.find((mode) => mode.value === value.mode)?.help}</Text>
          {value.mode !== 'none' ? (
            <Stack gap="xs">
              <Input label="Chemin local du dépôt" placeholder="/home/moi/mon projet" maxLength={4096} value={value.path}
                onChange={(path) => editDraft({ path })} disabled={!!busy} />
              <Text muted size="sm">Indiquez la racine du checkout Git principal, pas celle d’un worktree lié.</Text>
            </Stack>
          ) : null}
          {confirm?.kind === 'direct' ? (
            <Callout tone="warning" title={`Monter le dossier hôte dans ${confirm.draft.name} ?`}>
              <Stack gap="sm">
                <Text>Chemin local canonique : <Code>{confirm.canonicalPath}</Code></Text>
                <Text>La sandbox pourra lire et modifier ce dossier sur l’hôte.</Text>
                <Row gap="sm" wrap>
                  <Button variant="outline" onPress={() => cancel(confirm)}>Annuler</Button>
                  <Button tone="danger" disabled={!canCreate} onPress={() => create(snapshot, confirm)}>Confirmer le montage et créer</Button>
                </Row>
              </Stack>
            </Callout>
          ) : (
            <Button icon="add" disabled={!canCreate || !!confirm} onPress={() => create(snapshot)}>
              {value.mode === 'direct' ? 'Vérifier le chemin local' : 'Créer la sandbox'}
            </Button>
          )}
        </Stack>
      </Card>

      <Collapsible title="Préparation et dépannage" description="Étapes manuelles sur l’hôte et dans Orca">
        <Stack gap="sm">
          <Text>Installez Docker Sandboxes (<Code>sbx</Code> 0.48.0 ou ultérieur). Sur l’hôte, connectez-vous avec <Code>sbx login</Code>, configurez les identifiants de l’agent via Docker et choisissez une politique réseau adaptée. Exécutez <Code>sbx setup ssh</Code> une fois.</Text>
          <Text>Si Tester SSH échoue, vérifiez votre connexion Docker et la configuration SSH, puis réessayez. Si OpenSSH répond mais qu’Orca échoue, utilisez Test dans Settings → SSH pour diagnostiquer le proxy ou le runtime. Ne contournez pas la vérification des clés d’hôte.</Text>
          <Text>Le panneau ne lance pas d’agent et ne modifie ni vos réglages SSH ni vos identifiants. Orca lance l’agent installé dans le gabarit.</Text>
          <Text>Avant de supprimer une sandbox, récupérez ses changements via Git. Dans un terminal, utilisez <Code>{'sbx rm <nom>'}</Code> et vérifiez la confirmation de Docker. Les fichiers internes non exportés seront perdus ; retirez vous-même la cible SSH devenue obsolète dans Orca.</Text>
        </Stack>
      </Collapsible>
    </Stack>
  )
}
