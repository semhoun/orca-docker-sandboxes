import { defineCheck } from 'orca/testing'

// Explicit stubs for every request prevent a check from calling the real worker handlers.
const noActions = {
  'sandboxes.create': unexpectedAction,
  'sandboxes.stop': unexpectedAction,
  'sandboxes.testSsh': unexpectedAction
}

function unexpectedAction(): never {
  throw new Error('A check scenario must not perform actions on mount.')
}

export default defineCheck({
  'liste vide': {
    requests: { ...noActions, 'sandboxes.list': { ok: true, value: [] } }
  },
  'sandboxes locales': {
    requests: {
      ...noActions,
      'sandboxes.list': { ok: true, value: [
        { name: 'atelier-api', id: 'fake-1', agent: 'claude', status: 'running' },
        { name: 'atelier-docs', id: 'fake-2', agent: 'codex', status: 'stopped' },
        { name: 'atelier-externe', id: null, agent: 'autre', status: 'unknown' }
      ] }
    }
  },
  'liste indisponible': {
    requests: {
      ...noActions,
      'sandboxes.list': { ok: false, error: { code: 'cli_unavailable', message: 'Docker Sandboxes est indisponible. Vérifiez l’installation de sbx.' } }
    }
  }
})
