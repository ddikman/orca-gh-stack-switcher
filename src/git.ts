// The git commands the switcher runs, in the workspace's folder. Worker-only (Node).
import { execFile } from 'node:child_process'
import { childEnv } from './env'

/** A git command failed; the message is what git printed, or why it was stopped. */
export class GitError extends Error {}

/** How long a git command may run before it is stopped, in ms. */
export const gitTimeouts = { quick: 15_000, network: 60_000 }

/** Never wait for a password prompt nobody can see; English output for stable messages. */
const GIT_VARIABLES = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

type Result = { stdout: string; code: number }

/** Runs git; resolves with any exit code listed in `okCodes`, rejects with a GitError otherwise. */
function run(cwd: string, args: string[], options: { okCodes?: number[]; timeoutMs?: number } = {}): Promise<Result> {
  const okCodes = options.okCodes ?? [0]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: childEnv(GIT_VARIABLES), timeout: options.timeoutMs ?? gitTimeouts.quick, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        if (okCodes.includes(code)) {
          resolve({ stdout, code })
          return
        }
        if (error && 'killed' in error && error.killed) {
          reject(new GitError(`git ${args[0]} took too long and was stopped`))
          return
        }
        const said = stderr.trim() || stdout.trim() || error?.message || `git ${args[0]} failed`
        reject(new GitError(said.replace(/^(fatal|error): /gm, '')))
      }
    )
  })
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await run(cwd, ['branch', '--show-current'])
  return stdout.trim() || null
}

/** Space-separated fields before the path in each kind of `status --porcelain=v2` entry. */
const STATUS_FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10 }

/**
 * Paths with changes a switch could carry over or lose: staged, unstaged or new files (ignored
 * ones are left out). A submodule counts only when a change to it is staged: a switch never goes
 * into submodules, so one left at another commit, or with edits inside, is neither moved nor lost.
 */
export async function uncommittedFiles(cwd: string): Promise<string[]> {
  // --untracked-files=normal: new files count, whatever status.showUntrackedFiles says.
  const { stdout } = await run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'])
  const entries = stdout.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.startsWith('? ')) {
      paths.push(entry.slice(2))
      continue
    }
    const fields = entry.split(' ')
    const before = STATUS_FIELDS_BEFORE_PATH[fields[0]!]
    if (before === undefined) continue
    if (fields[0] === '2') index++ // A rename or copy is followed by its original path.
    const [staged] = fields[1]!
    const isSubmodule = fields[2]!.startsWith('S')
    if (isSubmodule && staged === '.') continue
    paths.push(fields.slice(before).join(' '))
  }
  return paths
}

export async function hasLocalBranch(cwd: string, branch: string): Promise<boolean> {
  const { code } = await run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    okCodes: [0, 1]
  })
  return code === 0
}

/** The folder of the worktree (this one or another) that has `branch` checked out, or null. */
export async function worktreeWithBranch(cwd: string, branch: string): Promise<string | null> {
  // Not `-z`: git before 2.36 refuses it, and Orca's worktree folders hold no newlines.
  const { stdout } = await run(cwd, ['worktree', 'list', '--porcelain'])
  for (const record of stdout.split(/\n\n+/)) {
    const fields = record.split('\n')
    if (fields.includes(`branch refs/heads/${branch}`)) {
      const worktree = fields.find((value) => value.startsWith('worktree '))
      return worktree ? worktree.slice('worktree '.length) : null
    }
  }
  return null
}

/** A remote URL's host and `owner/repo` path, lower-cased; null host for a local path. */
function parseRemoteUrl(url: string): { host: string | null; path: string } {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(url)
  // scp-like: [user@]host:owner/repo, but not a Windows drive (C:\...) or a local path.
  const scpLike = withScheme ? null : /^(?:[^@/]*@)?([^/:]{2,}):(?!\/\/)(.*)$/.exec(url)
  const [, host, path] = withScheme ?? scpLike ?? [null, null, url]
  return {
    host: host ? host.toLowerCase() : null,
    path: path!.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()
  }
}

export type GitHubRepo = { host: string; owner: string; repo: string }

/**
 * The remote to fetch `repo`'s branches from, or null when none clearly is: one on the same
 * host and path (`origin` first), else the only one with that path on any host (an SSH alias
 * from ~/.ssh/config), else the only one on that host (a repository renamed since cloning,
 * which GitHub redirects).
 */
export async function remoteFor(cwd: string, repo: GitHubRepo): Promise<string | null> {
  const names = (await run(cwd, ['remote'])).stdout.split('\n').filter(Boolean)
  // The URL as configured: no `[blob:none]` suffix as `remote -v` prints for a partial clone, and
  // still GitHub's when an insteadOf rule rewrites it to a proxy or mirror for fetching.
  const configured = await Promise.all(
    names.map(async (name) => {
      const { stdout } = await run(cwd, ['config', '--get', `remote.${name}.url`], { okCodes: [0, 1] })
      return { name, url: stdout.trim() }
    })
  )
  const remotes = configured.filter(({ url }) => url !== '').map(({ name, url }) => ({ name, ...parseRemoteUrl(url) }))
  const host = repo.host.toLowerCase()
  const path = `${repo.owner}/${repo.repo}`.toLowerCase()
  const exact = remotes.filter((remote) => remote.host === host && remote.path === path)
  if (exact.length > 0) {
    return (exact.find((remote) => remote.name === 'origin') ?? exact[0]!).name
  }
  const samePath = remotes.filter((remote) => remote.path === path)
  if (samePath.length === 1) {
    return samePath[0]!.name
  }
  const sameHost = remotes.filter((remote) => remote.host === host)
  return sameHost.length === 1 ? sameHost[0]!.name : null
}

/**
 * The GitHub repository `branch` is pushed to: its upstream remote's, else origin's. Null when that
 * remote is a local folder or not `owner/repo` shaped. An SSH host alias (no dot) means github.com.
 */
export async function pushedRepo(cwd: string, branch: string): Promise<GitHubRepo | null> {
  const upstream = await configValue(cwd, `branch.${branch}.remote`)
  const remote = upstream && upstream !== '.' ? upstream : 'origin'
  const url = await configValue(cwd, `remote.${remote}.url`)
  if (!url) return null
  const { host, path } = parseRemoteUrl(url)
  const [owner, repo, ...rest] = path.split('/')
  if (!host || !owner || !repo || rest.length > 0) return null
  return { host: host.includes('.') ? host : 'github.com', owner, repo }
}

/** True for a name git accepts as a branch as written: nothing option-like or expanded (@{-1}). */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (name === '' || name.startsWith('-')) {
    return false
  }
  const { stdout, code } = await run(cwd, ['check-ref-format', '--branch', name], { okCodes: [0, 1, 128, 129] })
  return code === 0 && stdout.trim() === name
}

/**
 * What git says when a fetch needed something from the person's shell: Orca starts plugins with
 * only PATH, HOME and the locale, so ssh-agent (SSH_AUTH_SOCK), tokens and proxies don't reach them.
 */
const NEEDS_SHELL_SETUP = [
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /Authentication failed/i,
  /could not read (Username|Password)/i,
  /terminal prompts disabled/i,
  /Could not resolve (host|proxy)/i,
  /Could not read from remote repository/i
]

/** Copies `branch` from `remote` into refs/remotes, whatever the remote's own fetch settings. */
async function fetchBranch(cwd: string, remote: string, branch: string): Promise<void> {
  try {
    await run(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], {
      timeoutMs: gitTimeouts.network
    })
  } catch (error) {
    const said = (error as Error).message
    if (!NEEDS_SHELL_SETUP.some((sign) => sign.test(said))) throw error
    throw new GitError(
      `${said}\nOrca runs plugins without your shell's ssh-agent, tokens and proxy settings. ` +
        `Run \`git fetch ${remote} ${branch}\` in a terminal, then switch again.`
    )
  }
}

async function commitOf(cwd: string, ref: string): Promise<string> {
  return (await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim()
}

async function isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
  return (await run(cwd, ['merge-base', '--is-ancestor', ancestor, of], { okCodes: [0, 1] })).code === 0
}

async function configValue(cwd: string, key: string): Promise<string> {
  return (await run(cwd, ['config', '--get', key], { okCodes: [0, 1] })).stdout.trim()
}

/**
 * Brings a local branch up to date with the remote branch it tracks, when that only moved forward
 * (pushed from another machine): nothing here is lost. Answers a note when they differ instead (a
 * restack or force-push there, commits of its own here, or no way to check), leaving it as it is.
 */
async function catchUp(cwd: string, branch: string): Promise<string | undefined> {
  const remote = await configValue(cwd, `branch.${branch}.remote`)
  const merge = await configValue(cwd, `branch.${branch}.merge`)
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) {
    return undefined // It tracks nothing on a remote.
  }
  const theirName = merge.slice('refs/heads/'.length)
  try {
    await fetchBranch(cwd, remote, theirName)
  } catch (error) {
    return `Couldn't check ${remote} for newer commits on ${branch}: ${(error as Error).message}`
  }
  const ours = await commitOf(cwd, `refs/heads/${branch}`)
  const theirs = await commitOf(cwd, `refs/remotes/${remote}/${theirName}`)
  if (ours === theirs || (await isAncestor(cwd, theirs, ours))) {
    return undefined // The same, or only ahead here (not pushed yet).
  }
  if (await isAncestor(cwd, ours, theirs)) {
    // `update-ref` with the old value: it moves the branch only if nothing else moved it meanwhile.
    await run(cwd, ['update-ref', '-m', `stack switcher: catch up with ${remote}`, `refs/heads/${branch}`, theirs, ours])
    return undefined
  }
  return (
    `${branch} on this machine differs from ${remote}'s: it was rewritten there, or has commits of its ` +
    'own here. This is the copy from this machine; check it before building on it.'
  )
}

export type SwitchResult = { note?: string }

/**
 * Checks out `branch` here. A local branch is first caught up with the remote branch it tracks; a
 * branch that only exists on `remote` is fetched and created to track it. Git refuses, and this
 * rejects, when uncommitted or ignored files would be overwritten, or another worktree has it.
 */
export async function switchBranch(cwd: string, branch: string, remote: string | null): Promise<SwitchResult> {
  let note: string | undefined
  if (await hasLocalBranch(cwd, branch)) {
    note = await catchUp(cwd, branch)
  } else {
    if (!remote) {
      throw new GitError(`${branch} isn't on this machine, and there's no remote to fetch it from.`)
    }
    await fetchBranch(cwd, remote, branch)
    // Not `switch --track`: a single-branch or shallow clone refuses to track a branch outside its
    // fetch refspec, and says so only after writing that branch's files into the worktree.
    await run(cwd, ['branch', '--quiet', '--no-track', branch, `refs/remotes/${remote}/${branch}`])
    await run(cwd, ['config', `branch.${branch}.remote`, remote])
    await run(cwd, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`])
  }
  // No time limit (0): stopping a checkout part-way leaves the other branch's files behind.
  // --no-overwrite-ignore: an ignored file here, such as a .env, can be the only copy of a secret.
  await run(cwd, ['switch', '--quiet', '--no-overwrite-ignore', branch], { timeoutMs: 0 })
  return note ? { note } : {}
}
