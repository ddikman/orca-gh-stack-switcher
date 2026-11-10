import { assert, test } from 'orca/testing'
import { findWorkspaceCandidates, type ListedWorkspace } from './workspace'

function workspace(id: string, name: string, branch: string | null, path = `/code/${id}`): ListedWorkspace {
  return { id, kind: 'worktree', name, path, branch, hostId: null }
}

const context = (displayName: string, branch: string) => ({ displayName, branch, terminals: [] })

const idsOf = (workspaces: ListedWorkspace[]) => workspaces.map((workspace) => workspace.id)

test('finds the open workspace by its name', () => {
  const workspaces = [workspace('a', 'login-page', 'feat/login'), workspace('b', 'stack-top', 'feat/wiring')]
  assert.deepEqual(idsOf(findWorkspaceCandidates(context('stack-top', 'feat/wiring'), workspaces)), ['b'])
})

test('tells same-named workspaces apart by branch', () => {
  const workspaces = [workspace('a', 'main', 'main'), workspace('b', 'main', 'feat/wiring')]
  assert.deepEqual(idsOf(findWorkspaceCandidates(context('main', 'feat/wiring'), workspaces)), ['b'])
})

test('still finds a workspace whose branch Orca has not caught up with yet', () => {
  // Right after a switch, Orca's list can still show the old branch for a moment.
  const workspaces = [workspace('a', 'stack-top', 'feat/screen')]
  assert.deepEqual(idsOf(findWorkspaceCandidates(context('stack-top', 'feat/wiring'), workspaces)), ['a'])
})

test('returns every look-alike that shares the name and branch', () => {
  const workspaces = [workspace('a', 'main', 'main'), workspace('b', 'main', 'main'), workspace('c', 'main', 'dev')]
  assert.deepEqual(idsOf(findWorkspaceCandidates(context('main', 'main'), workspaces)), ['a', 'b'])
})

test('finds nothing when no workspace is open', () => {
  assert.deepEqual(findWorkspaceCandidates(null, [workspace('a', 'main', 'main')]), [])
})
