import { assert, mockHost, mount, test } from 'orca/testing'
import type { PluginRequests } from 'orca'
import * as panel from './panel'
import type { Result, Sandbox } from './protocol'

const sandbox: Sandbox = { name: 'atelier-api', id: 'fake-1', agent: 'claude', status: 'running' }
const list = (rows: Sandbox[]): Result<Sandbox[]> => ({ ok: true, value: rows })

test('double création : une requête, puis une seule lecture de réconciliation', async () => {
  const calls: string[] = []
  const name = 'nouveau-projet'
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  let finishCreate: (value: Result<{ canonicalPath?: string }>) => void = () => { throw new Error('Create did not start') }
  const host = mockHost({ requests: {
    'sandboxes.list': () => {
      calls.push('list')
      return list(calls.length === 1 ? [] : [{ ...sandbox, name }])
    },
    'sandboxes.create': (input) => {
      calls.push('create')
      assert.deepEqual(input, { name, agent: 'claude', mode: 'none' })
      return new Promise((resolve) => { finishCreate = resolve; markStarted() })
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.type({ label: 'Nom' }, name)
    const button = view.find({ type: 'Button', text: 'Créer la sandbox' })
    assert.ok(button)
    const first = view.press(button)
    const second = Promise.allSettled([view.press(button)])
    await Promise.race([started, first])
    assert.deepEqual(calls, ['list', 'create'])
    finishCreate({ ok: true, value: {} })
    await first
    await second
    assert.deepEqual(calls, ['list', 'create', 'list'])
    assert.ok(view.find({ label: `Connexion à ${name}` }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally {
    await view.unmount()
  }
})

test('transport en échec : masque le détail et bloque la relance tant que la liste échoue', async () => {
  const calls: string[] = []
  let canList = true
  const host = mockHost({ requests: {
    'sandboxes.list': () => {
      calls.push('list')
      return canList ? list([sandbox]) : { ok: false, error: { code: 'bad_list', message: 'Liste indisponible.' } }
    },
    'sandboxes.create': () => {
      calls.push('create')
      canList = false
      throw new Error('RAW_TRANSPORT_DETAIL')
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.type({ label: 'Nom' }, 'nouveau-projet')
    await view.press({ text: 'Créer la sandbox' })
    assert.deepEqual(calls, ['list', 'create', 'list'])
    const staleTree = JSON.stringify(view.tree())
    assert.ok(staleTree.includes('Dernière liste connue'))
    assert.ok(staleTree.includes('La sandbox existe peut-être déjà'))
    assert.ok(!staleTree.includes('RAW_TRANSPORT_DETAIL'))
    await assert.rejects(view.press({ text: 'Créer la sandbox' }))
    assert.deepEqual(calls, ['list', 'create', 'list'])
    canList = true
    await view.press({ text: 'Actualiser' })
    assert.deepEqual(calls, ['list', 'create', 'list', 'list'])
    assert.ok(!JSON.stringify(view.tree()).includes('Dernière liste connue'))
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('montage direct : prévisualise, annule et confirme uniquement le chemin canonique affiché', async () => {
  const calls: unknown[] = []
  const input = { name: 'atelier-direct', agent: 'codex', mode: 'direct', path: '/tmp/Mon projet' }
  const canonicalPath = '/home/moi/checkout canonique'
  const host = mockHost({ requests: {
    'sandboxes.list': () => { calls.push('list'); return list([]) },
    'sandboxes.create': (request) => {
      calls.push(request)
      return { ok: true, value: request.preview ? { canonicalPath } : {} }
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.type({ label: 'Nom' }, input.name)
    await view.select({ label: 'Agent' }, input.agent)
    await view.select({ label: 'Mode de partage' }, input.mode)
    await view.type({ label: 'Chemin local du dépôt' }, input.path)
    await view.press({ text: 'Vérifier le chemin local' })
    const preview = { ...input, preview: true }
    assert.deepEqual(calls, ['list', preview, 'list'])
    assert.ok(view.find({ type: 'Code', text: canonicalPath }))
    await view.press({ text: 'Annuler' })
    assert.deepEqual(calls, ['list', preview, 'list'])
    assert.equal(view.find({ text: 'Confirmer le montage et créer' }), null)
    await view.press({ text: 'Vérifier le chemin local' })
    await view.press({ text: 'Confirmer le montage et créer' })
    assert.deepEqual(calls, ['list', preview, 'list', preview, 'list', { ...input, confirmedPath: canonicalPath }, 'list'])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally {
    await view.unmount()
  }
})

test('arrêt : le renouvellement de l’identité invalide la confirmation et un identifiant absent interdit l’arrêt', async () => {
  let row = sandbox
  const stops: PluginRequests['sandboxes.stop']['input'][] = []
  const host = mockHost({ requests: {
    'sandboxes.list': () => list([row]),
    'sandboxes.stop': (request) => {
      stops.push(request)
      row = { ...row, status: 'stopped' }
      return { ok: true, value: null }
    },
    'sandboxes.testSsh': () => ({ ok: true, value: { directory: '/run/sandbox/source/depot' } })
  } })
  const view = await mount(panel, { host })
  try {
    await view.press({ label: sandbox.name })
    await view.press({ text: 'Arrêter' })
    assert.ok(JSON.stringify(view.tree()).includes(`Arrêter ${sandbox.name} ?`))
    assert.deepEqual(stops, [])
    row = { ...row, id: null }
    await view.press({ text: 'Actualiser' })
    assert.equal(view.find({ text: 'Confirmer l’arrêt' }), null)
    await view.press({ label: row.name })
    await assert.rejects(view.press({ text: 'Arrêter' }))
    assert.deepEqual(stops, [])
    await view.press({ text: 'Tester SSH' })
    assert.ok(JSON.stringify(view.tree()).includes('aucun répertoire de travail exploitable'))
    assert.ok(!JSON.stringify(view.tree()).includes('/run/sandbox/source/depot'))
    row = { ...row, id: 'fake-2' }
    await view.press({ text: 'Actualiser' })
    await view.press({ label: row.name })
    await view.press({ text: 'Arrêter' })
    await view.press({ text: 'Confirmer l’arrêt' })
    assert.deepEqual(stops, [{ name: row.name, id: 'fake-2', confirmed: true }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally {
    await view.unmount()
  }
})
