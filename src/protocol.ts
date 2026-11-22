export type Agent = 'claude' | 'codex'
export type Mode = 'none' | 'clone' | 'direct'
export type Sandbox = {
  name: string
  id: string | null
  agent: string
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown'
}
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; uncertain?: boolean } }

const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export function isSandboxName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 63 &&
    value !== 'default' && label.test(value)
}

declare module 'orca' {
  interface PluginRequests {
    'sandboxes.list': { input: Record<string, never>; output: Result<Sandbox[]> }
    'sandboxes.create': {
      input: { name: string; agent: Agent; mode: Mode; path?: string; preview?: boolean; confirmedPath?: string }
      output: Result<{ canonicalPath?: string }>
    }
    'sandboxes.stop': { input: { name: string; id: string; confirmed: true }; output: Result<null> }
    'sandboxes.testSsh': {
      input: { name: string; id: string | null }
      output: Result<{ directory: string | null }>
    }
  }
}
