# AGENTS.md

## Orca workflow

- This folder is the plugin. Orca loads the TypeScript entries in `orca-plugin.json` directly (Orca >= 1.4.247). There is no `npm install`, build, or dev-server step.
- Run `orca plugin types .` if `.orca/types/` is missing. The root `tsconfig.json` extends the generated config. Dev load also refreshes it; do not edit or commit `.orca/`.
- From the root, `orca plugin test .` runs both test files with Orca's TS/TSX loader. The command takes a directory, not a test file or name filter. Plain `node --test` is not a substitute for the panel tests. Panel tests use `orca/testing` mocks; worker tests inject `makeHandlers(run)` and need local Git for the subprocess smoke test, not `sbx`, Docker, or SSH.
- `orca plugin validate .` checks the manifest without running plugin code. `orca plugin check .` also renders the scenarios in `src/panel.check.ts`. Stub every `sandboxes.*` request in each scenario: unstubbed requests can reach the actual worker. Check and test run locally without an open Orca window.
- For live UI work, `orca plugin dev load .` needs explicit approval before the trusted worker can run. The worker runs as the Orca host user, outside the microVM, even with `capabilities: []`.

## Panel and worker contract

- `src/panel.tsx` uses `orca` components and atoms, not React or DOM APIs. `src/protocol.ts` augments `PluginRequests`; `src/worker.ts` registers handlers in its default `activate` export and runs host commands through the shell-free, environment-filtered `src/process.ts` adapter. Keep English and French copy in `src/panel-messages.ts` and `src/worker-messages.ts`. The panel follows Orca's locale and falls back to English. Set the locale explicitly in tests that select localized controls.
- Read state from `sbx ls --json --no-input` (array format; the worker requires at least 0.48.0 and tests use 0.54.0 output). A failed refresh is not an empty list. Reconcile after actions, including uncertain results, rather than retrying a mutation automatically.
- Use `sbx create`, not `sbx run`: `none` omits the path, `clone` adds `--clone`, and `direct` requires confirmation of the worker's canonical path preview. Both path modes require the primary Git checkout root, not a linked worktree. Stop requires confirmation and a fresh name/ID match; never force it.
- SSH setup and Orca target creation are manual. The OpenSSH probe can start a stopped sandbox and does not validate Orca's remote runtime. Keep strict host-key checking and never offer `/run/sandbox/source` as the writable project.
