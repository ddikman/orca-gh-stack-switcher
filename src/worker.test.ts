// Runs src/worker.ts's activate(orca) over Orca's stand-in host, which refuses any call the
// manifest does not declare a capability for. Git runs for real on throwaway repositories.
import { join } from 'node:path'
import { afterEach, assert, beforeEach, mockHost, mountWorker, test } from 'orca/testing'
import { git, makeStackRepos, type StackRepos } from './test-repos'
import * as main from './worker'

let repos: StackRepos
beforeEach(() => {
  repos = makeStackRepos()
})
afterEach(() => repos.dispose())

function orcaShowing(options: { others?: { id: string; name: string; path: string; branch: string }[]; agents?: string[] } = {}) {
  return mockHost({
    results: {
      'workspace.readContext': { displayName: 'widgets', branch: 'main', terminals: [{ id: 't1', title: 'zsh' }] },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'widgets', path: repos.clone, branch: 'main', hostId: null },
          ...(options.others ?? []).map((other) => ({ ...other, kind: 'worktree', hostId: null }))
        ],
        truncated: false
      },
      'agents.list': {
        agents: (options.agents ?? []).map((state) => ({
          terminalId: 't1',
          title: 'Claude',
          agent: 'claude',
          state,
          stateStartedAt: 0
        }))
      },
      'workspace.open': { opened: true }
    }
  })
}

/** A row the panel showed for the workspace "widgets" (w1). */
const target = (branch: string) => ({ number: 12, branch, url: 'https://github.com/acme/widgets/pull/12', workspaceId: 'w1' })

test('switches the open workspace when the panel asks', async () => {
  const worker = await mountWorker(main, { host: orcaShowing() })
  assert.deepEqual(await worker.request('stack.switch', target('feat/screen')), {
    kind: 'switched',
    branch: 'feat/screen'
  })
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'feat/screen')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('asks Orca to open the workspace that already has the branch', async () => {
  const other = join(repos.root, 'screen-worktree')
  git(repos.clone, 'worktree', 'add', '--quiet', other, 'feat/screen')
  const host = orcaShowing({ others: [{ id: 'w2', name: 'screen', path: other, branch: 'feat/screen' }] })
  const worker = await mountWorker(main, { host })
  const outcome = await worker.request('stack.switch', target('feat/screen'))
  assert.equal(outcome.kind, 'opened')
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'w2' }])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test("reads the workspace's agents from Orca before switching", async () => {
  const worker = await mountWorker(main, { host: orcaShowing({ agents: ['working'] }) })
  const outcome = await worker.request('stack.switch', target('feat/screen'))
  assert.equal(outcome.kind, 'refused')
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'main')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('runs one switch at a time', async () => {
  const worker = await mountWorker(main, { host: orcaShowing() })
  const [first, second] = await Promise.all([
    worker.request('stack.switch', target('feat/screen')),
    worker.request('stack.switch', target('feat/model'))
  ])
  assert.deepEqual(first, { kind: 'switched', branch: 'feat/screen' })
  assert.equal(second.kind, 'refused')
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'feat/screen')
  await worker.deactivate()
})

test('refuses a switch request that does not say which workspace it is for', async () => {
  const worker = await mountWorker(main, { host: orcaShowing() })
  const { workspaceId: _left, ...withoutWorkspace } = target('feat/screen')
  const outcome = await worker.request('stack.switch', withoutWorkspace as never)
  assert.equal(outcome.kind, 'refused')
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'main')
  await worker.deactivate()
})

test('says there is nothing to show when no workspace is open', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('stack.load'), { kind: 'no-workspace' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
