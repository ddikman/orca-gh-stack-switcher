// Loads the open workspace's stack and switches between its PRs. Worker-only (runs git and gh).
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import {
  currentBranch,
  hasLocalBranch,
  pushedRepo,
  isValidBranchName,
  remoteFor,
  switchBranch,
  uncommittedFiles,
  worktreeWithBranch
} from './git'
import { parsePullRequestUrl, type createGitHub } from './github'
import type { StackView, SwitchOutcome, SwitchTarget } from './protocol'
import { parseStack } from './stack'
import { findWorkspaceCandidates, type ListedWorkspace, type WorkspaceContext } from './workspace'

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** The Orca host calls the switcher makes; src/worker.ts backs them with `orca.host.call`. */
export type SwitcherHost = {
  readContext(): Promise<WorkspaceContext>
  listWorkspaces(): Promise<ListedWorkspace[]>
  openWorkspace(id: string): Promise<void>
  listAgents(): Promise<{ state: AgentState }[]>
}

export type SwitcherDeps = { host: SwitcherHost; github: ReturnType<typeof createGitHub> }

/** An agent that is mid-task: switching branches under it would pull its files away. */
const BUSY_AGENT_STATES: readonly AgentState[] = ['working', 'blocked']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Focus =
  | { kind: 'none'; view: Extract<StackView, { kind: 'no-workspace' | 'other-host' | 'error' }> }
  | { kind: 'one'; workspace: ListedWorkspace }
  /** Look-alikes that share the open workspace's name and branch, here or on other machines. */
  | { kind: 'several'; workspaces: ListedWorkspace[]; name: string; branch: string }

/** On this machine, rather than an SSH host. Orca lists local worktrees as "local", folders as null. */
function isLocal(workspace: ListedWorkspace): boolean {
  return workspace.hostId === null || workspace.hostId === 'local'
}

/** The focused workspace's row(s) from `workspace.list`, or the view that says why there is none. */
async function findFocus(host: SwitcherHost): Promise<Focus> {
  const context = await host.readContext()
  if (!context) {
    return { kind: 'none', view: { kind: 'no-workspace' } }
  }
  const candidates = findWorkspaceCandidates(context, await host.listWorkspaces())
  // A workspace here whose folder is gone can't be the open one; one on another machine can.
  const possible = candidates.filter((workspace) => !isLocal(workspace) || existsSync(workspace.path))
  if (possible.length > 1) {
    return { kind: 'several', workspaces: possible, name: context.displayName, branch: context.branch }
  }
  const [only] = possible
  if (only && isLocal(only)) {
    return { kind: 'one', workspace: only }
  }
  if (only) {
    return { kind: 'none', view: { kind: 'other-host', workspace: only.name } }
  }
  const message =
    candidates.length > 0
      ? `Can't find ${context.displayName}'s folder on this machine.`
      : `Couldn't find the workspace "${context.displayName}" in Orca's list.`
  return { kind: 'none', view: { kind: 'error', message } }
}

/** What the panel shows for one workspace. */
async function viewOf(github: SwitcherDeps['github'], workspace: ListedWorkspace): Promise<StackView> {
  const { id, name, path } = workspace
  if (!isLocal(workspace)) {
    return { kind: 'other-host', workspace: name }
  }
  // Git, not Orca's context: Orca notices a branch change a moment after it happens.
  const branch = await currentBranch(path)
  if (!branch) {
    return { kind: 'no-branch', workspace: name }
  }
  // The repository the branch is pushed to: with several remotes, gh alone may ask another.
  const pr = await github.findPullRequest(path, branch, (await pushedRepo(path, branch)) ?? undefined)
  if (!pr) {
    return { kind: 'no-pr', workspace: name, branch }
  }
  const stack = parseStack(await github.fetchStack(path, pr), pr.number)
  if (!stack) {
    return { kind: 'no-stack', workspace: name, branch, pr: pr.number }
  }
  return { kind: 'stack', workspace: name, workspaceId: id, branch, pr: pr.number, stack }
}

export async function loadStack({ host, github }: SwitcherDeps): Promise<StackView> {
  try {
    const focus = await findFocus(host)
    if (focus.kind === 'none') {
      return focus.view
    }
    if (focus.kind === 'one') {
      return await viewOf(github, focus.workspace)
    }
    // Orca can't say which look-alike is open, but when they would all show the same thing
    // (typically: no PR for main), that is the answer whichever it is.
    const views = await Promise.all(
      focus.workspaces.map((workspace) =>
        viewOf(github, workspace).catch((error): StackView => ({ kind: 'error', message: messageOf(error) }))
      )
    )
    const first = JSON.stringify(views[0])
    if (views.every((view) => JSON.stringify(view) === first)) {
      return views[0]!
    }
    return { kind: 'ambiguous', workspace: focus.name, branch: focus.branch }
  } catch (error) {
    return { kind: 'error', message: messageOf(error) }
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  const resolve = (path: string) => realpath(path).catch(() => path)
  return (await resolve(a)) === (await resolve(b))
}

async function workspaceAt(host: SwitcherHost, path: string): Promise<ListedWorkspace | null> {
  for (const workspace of await host.listWorkspaces()) {
    if (await samePath(workspace.path, path)) {
      return workspace
    }
  }
  return null
}

const refused = (reason: string): SwitchOutcome => ({ kind: 'refused', reason })

export async function switchTo({ host }: SwitcherDeps, target: SwitchTarget): Promise<SwitchOutcome> {
  try {
    const focus = await findFocus(host)
    if (focus.kind === 'none') {
      const { view } = focus
      return refused(
        view.kind === 'error'
          ? view.message
          : view.kind === 'other-host'
            ? `${view.workspace} is on another machine, and Stack Switcher only switches workspaces on this one.`
            : 'No workspace is open.'
      )
    }
    if (focus.kind === 'several') {
      return refused(
        `Several workspaces are named "${focus.name}" and are on ${focus.branch}, so it can't tell which ` +
          'folder to switch. Rename this one in Orca, then switch.'
      )
    }
    // The panel's rows are for the workspace it loaded; the person may have moved on since.
    if (focus.workspace.id !== target.workspaceId) {
      return refused('The open workspace changed since the panel loaded its stack. Check the list, then switch again.')
    }
    const { path } = focus.workspace
    const { branch } = target
    if (!(await isValidBranchName(path, branch))) {
      return refused(`"${branch}" isn't a branch name git can switch to.`)
    }
    if ((await currentBranch(path)) === branch) {
      return refused(`This workspace is already on ${branch}.`)
    }

    // Git allows a branch in one worktree at a time: if another has it, go there instead.
    const elsewhere = await worktreeWithBranch(path, branch)
    if (elsewhere) {
      const other = await workspaceAt(host, elsewhere)
      if (!other) {
        return refused(`${branch} is checked out in ${elsewhere}, which isn't an Orca workspace.`)
      }
      await host.openWorkspace(other.id)
      return { kind: 'opened', workspace: other.name, branch }
    }

    const busy = (await host.listAgents()).filter((agent) => BUSY_AGENT_STATES.includes(agent.state))
    if (busy.length > 0) {
      return refused('An agent in this workspace is still working. Switch once it has finished.')
    }
    const changed = await uncommittedFiles(path)
    if (changed.length > 0) {
      const files = changed.length === 1 ? '1 file' : `${changed.length} files`
      return refused(`This workspace has uncommitted changes in ${files}. Commit or stash them, then switch.`)
    }

    const repo = parsePullRequestUrl(target.url, target.number)
    const remote = repo ? await remoteFor(path, repo) : null
    if (!remote && !(await hasLocalBranch(path, branch))) {
      const name = repo ? `${repo.owner}/${repo.repo}` : 'the PR’s repository'
      return refused(`${branch} isn't on this machine, and no git remote here points at ${name} to fetch it from.`)
    }
    try {
      const { note } = await switchBranch(path, branch, remote)
      return note ? { kind: 'switched', branch, note } : { kind: 'switched', branch }
    } catch (error) {
      return await explainSwitchFailure(path, branch, messageOf(error))
    }
  } catch (error) {
    return { kind: 'failed', message: messageOf(error) }
  }
}

/** What a failed `git switch` means for the person. */
async function explainSwitchFailure(path: string, branch: string, said: string): Promise<SwitchOutcome> {
  // Git can fail after HEAD has moved: a post-checkout hook's exit status becomes git's.
  if ((await currentBranch(path).catch(() => null)) === branch) {
    return { kind: 'switched', branch, note: `Switched, but git reported a problem afterwards: ${said}` }
  }
  if (/would be overwritten by checkout/.test(said)) {
    const files = said
      .split('\n')
      .filter((line) => /^\s+\S/.test(line))
      .map((line) => line.trim())
    const named = files.length > 0 ? files.join(', ') : 'files'
    return refused(
      `Switching would overwrite ${named}, which ${files.length === 1 ? "isn't" : "aren't"} committed here ` +
        '(git may be ignoring them). Move them aside, then switch.'
    )
  }
  return { kind: 'failed', message: said }
}
