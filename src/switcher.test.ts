import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import { createGitHub, GitHubError, type RunGh } from './github'
import { loadStack, switchTo, type AgentState, type SwitcherHost } from './switcher'
import { stackResponse, threePrStack } from './test-fixtures'
import { commit, git, makeStackRepos, type StackRepos } from './test-repos'
import type { ListedWorkspace } from './workspace'

let repos: StackRepos
beforeEach(() => {
  repos = makeStackRepos()
})
afterEach(() => repos.dispose())

function workspace(id: string, name: string, path: string, branch: string | null, hostId: string | null = 'local'): ListedWorkspace {
  return { id, kind: 'worktree', name, path, branch, hostId }
}

/** Orca, showing the clone as the open workspace (default "widgets" on main) plus any others given. */
function fakeOrca(
  options: {
    name?: string
    branch?: string
    /** The open workspace's name, when it is not the clone's. */
    focusedName?: string
    others?: ListedWorkspace[]
    agents?: AgentState[]
    focused?: boolean
  } = {}
) {
  const opened: string[] = []
  const name = options.name ?? 'widgets'
  const branch = options.branch ?? 'main'
  const displayName = options.focusedName ?? name
  const host: SwitcherHost = {
    readContext: async () => (options.focused === false ? null : { displayName, branch, terminals: [] }),
    listWorkspaces: async () => [workspace('w1', name, repos.clone, branch), ...(options.others ?? [])],
    openWorkspace: async (id) => {
      opened.push(id)
    },
    listAgents: async () => (options.agents ?? []).map((state) => ({ state }))
  }
  return { host, opened }
}

/**
 * gh, knowing PRs #11-#13 of acme/widgets and their stack. Folders in `noPrsIn` are another
 * repository; folders in `noRemoteIn` have no git remote, as a repository not yet pushed.
 */
function fakeGitHub(options: { stack?: unknown; fails?: string; noPrsIn?: string[]; noRemoteIn?: string[] } = {}) {
  const prs: Record<string, number> = { 'feat/model': 11, 'feat/screen': 12, 'feat/wiring': 13 }
  const runGh: RunGh = async (args, cwd) => {
    assert.ok(cwd.startsWith(repos.root), `gh ran outside the workspaces, in ${cwd}`)
    ghCalls.push(args)
    if (options.fails) throw new GitHubError(options.fails)
    if (options.noRemoteIn?.includes(cwd)) throw new GitHubError('no git remotes found')
    if (args[0] === 'pr' && args[1] === 'list') {
      const branch = args[args.indexOf('--head') + 1]!
      const number = options.noPrsIn?.includes(cwd) ? undefined : prs[branch]
      return JSON.stringify(number ? [{ number, state: 'OPEN', url: `https://github.com/acme/widgets/pull/${number}` }] : [])
    }
    return JSON.stringify(options.stack ?? threePrStack())
  }
  return createGitHub(runGh)
}

/** Every gh command the fake answered in this test. */
let ghCalls: string[][] = []
beforeEach(() => {
  ghCalls = []
})

/** A row the panel showed for the clone's workspace (w1), unless told it showed another. */
const target = (number: number, branch: string, repo = 'acme/widgets', workspaceId = 'w1') => ({
  number,
  branch,
  url: `https://github.com/${repo}/pull/${number}`,
  workspaceId
})

const branchOf = (path: string) => git(path, 'branch', '--show-current')

/** Another, separate clone of the remote: another repository's checkout, as far as Orca knows. */
function secondClone(branch = 'main', folder = 'clone-2'): string {
  const path = join(repos.root, folder)
  git(repos.root, 'clone', '--quiet', repos.remote, path)
  git(path, 'switch', '--quiet', branch)
  return path
}

// Loading

test('shows the stack of the PR the workspace is on', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub() })
  assert.equal(view.kind, 'stack')
  if (view.kind !== 'stack') return
  assert.equal(view.workspace, 'widgets')
  assert.equal(view.workspaceId, 'w1')
  assert.equal(view.branch, 'feat/screen')
  assert.equal(view.pr, 12)
  assert.deepEqual(
    view.stack.entries.map((entry) => [entry.number, entry.current]),
    [[13, false], [12, true], [11, false]]
  )
})

test('asks GitHub about the repository the branch is pushed to, not the one gh would guess', async () => {
  // With several GitHub remotes and no default, gh tries `upstream` before `origin`.
  git(repos.clone, 'remote', 'add', 'upstream', 'https://github.com/oss/widgets.git')
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub() })
  assert.equal(view.kind === 'stack' && view.pr, 12)
  const lookup = ghCalls.find((args) => args[1] === 'list')!
  assert.equal(lookup[lookup.indexOf('--repo') + 1], 'acme/widgets')
})

test("reads the branch from git, even before Orca's own view has caught up", async () => {
  // fakeOrca still reports "main"; git is already on feat/wiring.
  git(repos.clone, 'switch', '--quiet', 'feat/wiring')
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub() })
  assert.equal(view.kind === 'stack' && view.pr, 13)
})

test('says when no workspace is open', async () => {
  const view = await loadStack({ host: fakeOrca({ focused: false }).host, github: fakeGitHub() })
  assert.deepEqual(view, { kind: 'no-workspace' })
})

test('says when the workspace is not on a branch', async () => {
  git(repos.clone, 'switch', '--quiet', '--detach')
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub() })
  assert.deepEqual(view, { kind: 'no-branch', workspace: 'widgets' })
})

test('says when the branch has no PR', async () => {
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub() })
  assert.deepEqual(view, { kind: 'no-pr', workspace: 'widgets', branch: 'main' })
})

test('says when the PR is not part of a stack', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub({ stack: stackResponse(null) }) })
  assert.deepEqual(view, { kind: 'no-stack', workspace: 'widgets', branch: 'feat/screen', pr: 12 })
})

// Orca names a repo's main checkout after its branch, so several repos' checkouts are all "main".
test('shows what same-named workspaces agree on, such as no PR for main', async () => {
  const other = secondClone()
  const orca = fakeOrca({ name: 'main', others: [workspace('w2', 'main', other, 'main')] })
  const view = await loadStack({ host: orca.host, github: fakeGitHub() })
  assert.deepEqual(view, { kind: 'no-pr', workspace: 'main', branch: 'main' })
})

test('shows no PR for "main" when one look-alike is a repository with no remote yet', async () => {
  // As in Orca: two GitHub repos' checkouts and a new local repo, all named "main" on main.
  const second = secondClone()
  const unpushed = secondClone('main', 'clone-3')
  const orca = fakeOrca({
    name: 'main',
    others: [workspace('w2', 'main', second, 'main'), workspace('w3', 'main', unpushed, 'main')]
  })
  const view = await loadStack({ host: orca.host, github: fakeGitHub({ noRemoteIn: [unpushed] }) })
  assert.deepEqual(view, { kind: 'no-pr', workspace: 'main', branch: 'main' })
})

test('ignores a look-alike on this machine whose folder is gone', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const gone = workspace('w2', 'widgets', join(repos.root, 'deleted-worktree'), 'feat/screen')
  const orca = fakeOrca({ branch: 'feat/screen', others: [gone] })
  const view = await loadStack({ host: orca.host, github: fakeGitHub() })
  assert.equal(view.kind === 'stack' && view.pr, 12)
})

test('says so when the open workspace is on another machine', async () => {
  const ssh = workspace('w9', 'devbox-widgets', '/home/me/widgets', 'main', 'ssh:devbox')
  const orca = fakeOrca({ focusedName: 'devbox-widgets', others: [ssh] })
  const view = await loadStack({ host: orca.host, github: fakeGitHub() })
  assert.deepEqual(view, { kind: 'other-host', workspace: 'devbox-widgets' })
  assert.deepEqual(ghCalls, [])
})

test('cannot tell a workspace here from a same-named one on another machine', async () => {
  // Orca names both after the branch. The SSH one's path even exists here.
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const ssh = workspace('w9', 'widgets', repos.clone, 'feat/screen', 'ssh:devbox')
  const orca = fakeOrca({ branch: 'feat/screen', others: [ssh] })
  const view = await loadStack({ host: orca.host, github: fakeGitHub() })
  assert.deepEqual(view, { kind: 'ambiguous', workspace: 'widgets', branch: 'feat/screen' })
})

test('shows no Switch for look-alikes on the same branch of the same repository', async () => {
  // Two separate clones of acme/widgets, both on feat/screen: the same stack, but which folder?
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const other = secondClone('feat/screen')
  const orca = fakeOrca({ branch: 'feat/screen', others: [workspace('w2', 'widgets', other, 'feat/screen')] })
  const view = await loadStack({ host: orca.host, github: fakeGitHub() })
  assert.equal(view.kind, 'ambiguous')
})

test('says it cannot tell look-alikes apart, rather than fail, when one of them errors', async () => {
  const other = secondClone()
  const orca = fakeOrca({ others: [workspace('w2', 'widgets', other, 'main')] })
  const github = createGitHub(async (_args, cwd) => {
    if (cwd === other) throw new GitHubError('HTTP 401: Bad credentials (https://ghe.example.com/api/graphql)')
    throw new GitHubError('no pull requests found for branch "main"')
  })
  const view = await loadStack({ host: orca.host, github })
  assert.deepEqual(view, { kind: 'ambiguous', workspace: 'widgets', branch: 'main' })
})

test('says it cannot tell same-named workspaces apart when they would show different things', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const other = secondClone('feat/screen')
  const orca = fakeOrca({ branch: 'feat/screen', others: [workspace('w2', 'widgets', other, 'feat/screen')] })
  const view = await loadStack({ host: orca.host, github: fakeGitHub({ noPrsIn: [other] }) })
  assert.deepEqual(view, { kind: 'ambiguous', workspace: 'widgets', branch: 'feat/screen' })
})

test('passes on what gh said when GitHub cannot be reached', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/screen')
  const view = await loadStack({ host: fakeOrca().host, github: fakeGitHub({ fails: 'gh auth login required' }) })
  assert.equal(view.kind, 'error')
  assert.match(view.kind === 'error' ? view.message : '', /^gh auth login required\n/)
})

// Switching

test('switches the workspace to a branch it already has', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/wiring')
  git(repos.clone, 'branch', '--quiet', '--track', 'feat/model', 'origin/feat/model')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(11, 'feat/model'))
  assert.deepEqual(outcome, { kind: 'switched', branch: 'feat/model' })
  assert.equal(branchOf(repos.clone), 'feat/model')
})

test("fetches a branch that is only on GitHub, then switches to it", async () => {
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.deepEqual(outcome, { kind: 'switched', branch: 'feat/screen' })
  assert.equal(branchOf(repos.clone), 'feat/screen')
})

test('opens the Orca workspace that already has the branch instead', async () => {
  const other = join(repos.root, 'screen-worktree')
  git(repos.clone, 'worktree', 'add', '--quiet', other, 'feat/screen')
  const orca = fakeOrca({ others: [workspace('w2', 'screen', other, 'feat/screen')] })
  const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.deepEqual(outcome, { kind: 'opened', workspace: 'screen', branch: 'feat/screen' })
  assert.deepEqual(orca.opened, ['w2'])
  assert.equal(branchOf(repos.clone), 'main')
})

test('still opens the other workspace while this one is busy, since nothing here changes', async () => {
  const other = join(repos.root, 'screen-worktree')
  git(repos.clone, 'worktree', 'add', '--quiet', other, 'feat/screen')
  writeFileSync(join(repos.clone, 'README.md'), 'work in progress')
  const orca = fakeOrca({ agents: ['working'], others: [workspace('w2', 'screen', other, 'feat/screen')] })
  const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'opened')
  assert.deepEqual(orca.opened, ['w2'])
})

test('refuses when the branch is checked out in a folder Orca does not know', async () => {
  const other = join(repos.root, 'screen-worktree')
  git(repos.clone, 'worktree', 'add', '--quiet', other, 'feat/screen')
  const orca = fakeOrca()
  const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /screen-worktree/)
  assert.deepEqual(orca.opened, [])
  assert.equal(branchOf(repos.clone), 'main')
})

for (const state of ['working', 'blocked'] as const) {
  test(`refuses while an agent in the workspace is ${state}`, async () => {
    const orca = fakeOrca({ agents: ['done', state] })
    const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen'))
    assert.equal(outcome.kind, 'refused')
    assert.match(outcome.kind === 'refused' ? outcome.reason : '', /agent/i)
    assert.equal(branchOf(repos.clone), 'main')
  })
}

test('switches when every agent is waiting or done', async () => {
  const orca = fakeOrca({ agents: ['waiting', 'done'] })
  const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'switched')
})

test('refuses when the workspace has uncommitted changes, and leaves them alone', async () => {
  writeFileSync(join(repos.clone, 'README.md'), 'work in progress')
  writeFileSync(join(repos.clone, 'notes.txt'), 'new file')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /2 files/)
  assert.equal(branchOf(repos.clone), 'main')
  assert.equal(git(repos.clone, 'status', '--porcelain'), 'M README.md\n?? notes.txt')
})

test('refuses a branch name git would read as something else', async () => {
  git(repos.clone, 'switch', '--quiet', 'feat/wiring')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(1, '@{-1}'))
  assert.equal(outcome.kind, 'refused')
  assert.equal(branchOf(repos.clone), 'feat/wiring')
})

test('refuses to fetch when no remote clearly is the PR’s repository', async () => {
  git(repos.clone, 'remote', 'add', 'upstream', 'https://github.com/oss/widgets.git')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(12, 'feat/screen', 'someone/fork'))
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /someone\/fork/)
  assert.equal(branchOf(repos.clone), 'main')
})

test('refuses to overwrite an ignored file that the other branch tracks', async () => {
  // main ignores .env, which holds the only copy of a secret; feat/env tracks a template .env.
  commit(repos.clone, '.gitignore', '.env\n')
  git(repos.clone, 'switch', '--quiet', '--create', 'feat/env')
  writeFileSync(join(repos.clone, '.env'), 'TOKEN=template')
  git(repos.clone, 'add', '--force', '.env')
  git(repos.clone, 'commit', '--quiet', '-m', 'Add a .env template')
  git(repos.clone, 'switch', '--quiet', 'main')
  writeFileSync(join(repos.clone, '.env'), 'TOKEN=secret')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(20, 'feat/env'))
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /\.env/)
  assert.equal(readFileSync(join(repos.clone, '.env'), 'utf8'), 'TOKEN=secret')
  assert.equal(branchOf(repos.clone), 'main')
})

test('reports a switch that happened even when a git hook complained afterwards', async () => {
  const hooks = join(repos.root, 'hooks')
  mkdirSync(hooks)
  writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\necho "husky - npm not found in PATH" >&2\nexit 1\n')
  chmodSync(join(hooks, 'post-checkout'), 0o755)
  git(repos.clone, 'config', 'core.hooksPath', hooks)
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'switched')
  assert.match(outcome.kind === 'switched' ? (outcome.note ?? '') : '', /npm not found/)
  assert.equal(branchOf(repos.clone), 'feat/screen')
})

test('brings a local branch up to date when GitHub has moved it on', async () => {
  git(repos.clone, 'branch', '--quiet', '--track', 'feat/model', 'origin/feat/model')
  const seed = join(repos.root, 'seed')
  git(seed, 'switch', '--quiet', 'feat/model')
  commit(seed, 'later.txt', 'pushed from another machine')
  git(seed, 'push', '--quiet', 'origin', 'feat/model')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(11, 'feat/model'))
  assert.deepEqual(outcome, { kind: 'switched', branch: 'feat/model' })
  assert.equal(git(repos.clone, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'feat/model'))
})

test('keeps a local branch that differs from GitHub’s, and says so', async () => {
  git(repos.clone, 'branch', '--quiet', '--track', 'feat/model', 'origin/feat/model')
  const before = git(repos.clone, 'rev-parse', 'feat/model')
  const seed = join(repos.root, 'seed')
  git(seed, 'switch', '--quiet', 'feat/model')
  git(seed, 'commit', '--quiet', '--amend', '-m', 'Restacked elsewhere')
  git(seed, 'push', '--quiet', '--force', 'origin', 'feat/model')
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(11, 'feat/model'))
  assert.equal(outcome.kind, 'switched')
  assert.match(outcome.kind === 'switched' ? (outcome.note ?? '') : '', /differs from/)
  assert.equal(git(repos.clone, 'rev-parse', 'HEAD'), before)
})

test('says what to do when fetching needs credentials Orca keeps from plugins', async () => {
  // Orca starts plugins without SSH_AUTH_SOCK, so a key held only in ssh-agent is out of reach.
  const ssh = join(repos.root, 'fake-ssh')
  writeFileSync(ssh, '#!/bin/sh\necho "git@github.com: Permission denied (publickey)." >&2\nexit 255\n')
  chmodSync(ssh, 0o755)
  git(repos.clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
  git(repos.clone, 'config', 'core.sshCommand', ssh)
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'failed')
  const message = outcome.kind === 'failed' ? outcome.message : ''
  assert.match(message, /Permission denied/)
  assert.match(message, /git fetch origin feat\/screen/)
  assert.equal(branchOf(repos.clone), 'main')
})

test('says so when the workspace is already on that branch', async () => {
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(1, 'main'))
  assert.equal(outcome.kind, 'refused')
})

test('reports what git said when the switch fails', async () => {
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(14, 'feat/missing'))
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.kind === 'failed' ? outcome.message : '', /feat\/missing/)
  assert.equal(branchOf(repos.clone), 'main')
})

test('refuses to switch when it cannot tell same-named workspaces apart', async () => {
  const other = secondClone()
  const orca = fakeOrca({ others: [workspace('w2', 'widgets', other, 'main')] })
  const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /rename/i)
  assert.equal(branchOf(repos.clone), 'main')
  assert.equal(branchOf(other), 'main')
})

test('refuses when the open workspace is not the one whose stack the panel showed', async () => {
  // The person moved to another workspace while the panel was still showing this one's stack.
  const outcome = await switchTo({ host: fakeOrca().host, github: fakeGitHub() }, target(12, 'feat/screen', 'acme/widgets', 'w7'))
  assert.equal(outcome.kind, 'refused')
  assert.equal(branchOf(repos.clone), 'main')
})

test('refuses when the open workspace is on another machine', async () => {
  const ssh = workspace('w9', 'devbox-widgets', '/home/me/widgets', 'main', 'ssh:devbox')
  const orca = fakeOrca({ focusedName: 'devbox-widgets', others: [ssh] })
  const outcome = await switchTo({ host: orca.host, github: fakeGitHub() }, target(12, 'feat/screen', 'acme/widgets', 'w9'))
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /another machine/)
})

test('refuses when no workspace is open', async () => {
  const outcome = await switchTo({ host: fakeOrca({ focused: false }).host, github: fakeGitHub() }, target(12, 'feat/screen'))
  assert.equal(outcome.kind, 'refused')
})
