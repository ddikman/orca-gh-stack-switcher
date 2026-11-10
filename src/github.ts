// What the switcher asks GitHub, through the gh CLI the person is already signed in to.
import { execFile } from 'node:child_process'
import { childEnv } from './env'

/** A gh command failed; the message is what gh printed. */
export class GitHubError extends Error {}

/** Runs gh with `args` in `cwd`; resolves with stdout, rejects with a GitHubError. */
export type RunGh = (args: string[], cwd: string) => Promise<string>

export type PullRequestRef = { number: number; host: string; owner: string; repo: string }

/** A repository on GitHub or GitHub Enterprise. */
export type RepoRef = { host: string; owner: string; repo: string }

/** What gh says when it isn't signed in, as far as Orca's plugins can see. */
const NEEDS_SIGN_IN = [/gh auth login/i, /HTTP 401/i, /Bad credentials/i]

/** Adds what to do when gh failed for want of credentials the plugin can't have. */
function withSignInAdvice(error: unknown): unknown {
  if (!(error instanceof GitHubError) || !NEEDS_SIGN_IN.some((sign) => sign.test(error.message))) {
    return error
  }
  return new GitHubError(
    `${error.message}\nOrca runs plugins without your shell's environment, so a GH_TOKEN set there ` +
      "doesn't reach them. Run gh auth login in a terminal to sign gh in where plugins can see it."
  )
}

/** gh's `--repo` value: `owner/repo` on github.com, `host/owner/repo` elsewhere. */
function repoSelector({ host, owner, repo }: RepoRef): string {
  return host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`
}

/** The same stack query Orca's own stack view sends, so both list the same PRs. */
const STACK_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      stack {
        number
        size
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest {
              number
              title
              url
              state
              isDraft
              headRefName
              mergeable
              reviewDecision
              statusCheckRollup { state }
            }
          }
        }
      }
    }
  }
}`

/**
 * What gh says when there can be no PR for the branch: none has it as its head, or the
 * repository has no GitHub remote at all (not pushed yet, or hosted elsewhere).
 */
const NO_PULL_REQUEST = [
  /no (open )?pull requests? found/i,
  /no git remotes found/i,
  /none of the git remotes configured for this repository point to a known GitHub host/i
]

/** `https://<host>/<owner>/<repo>/pull/<n>` → its parts; null for anything else. */
export function parsePullRequestUrl(url: unknown, number: number): PullRequestRef | null {
  if (typeof url !== 'string') return null
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url)
  return match ? { number, host: match[1]!, owner: match[2]!, repo: match[3]! } : null
}

export function createGitHub(runGh: RunGh) {
  return {
    /**
     * The PR whose head is the branch named `branch` (its open one, else the latest), in `repo` when
     * given, else the repository gh picks for `cwd`; null when there is none.
     */
    async findPullRequest(cwd: string, branch: string, repo?: RepoRef): Promise<PullRequestRef | null> {
      // `pr list --head`, not `pr view <branch>`: gh reads a branch named "1234" as PR #1234.
      const args = ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state', '--limit', '20']
      if (repo) args.push('--repo', repoSelector(repo))
      let stdout: string
      try {
        stdout = await runGh(args, cwd)
      } catch (error) {
        if (error instanceof GitHubError && NO_PULL_REQUEST.some((said) => said.test(error.message))) {
          return null
        }
        throw withSignInAdvice(error)
      }
      const listed = JSON.parse(stdout) as { number?: unknown; url?: unknown; state?: unknown }[]
      if (!Array.isArray(listed) || listed.length === 0) return null
      const chosen = listed.find((candidate) => candidate.state === 'OPEN') ?? listed[0]!
      const ref = typeof chosen.number === 'number' ? parsePullRequestUrl(chosen.url, chosen.number) : null
      if (!ref) throw new GitHubError(`gh answered something unexpected: ${stdout.slice(0, 200)}`)
      return ref
    },

    /** GitHub's raw answer to the stack query for `pr`; `parseStack` reads it. */
    async fetchStack(cwd: string, pr: PullRequestRef): Promise<unknown> {
      const host = pr.host === 'github.com' ? [] : ['--hostname', pr.host]
      const stdout = await runGh(
        [
          'api',
          'graphql',
          ...host,
          '-f',
          `query=${STACK_QUERY}`,
          '-f',
          `owner=${pr.owner}`,
          '-f',
          `repo=${pr.repo}`,
          '-F',
          `pr=${pr.number}`
        ],
        cwd
      ).catch((error: unknown) => {
        throw withSignInAdvice(error)
      })
      return JSON.parse(stdout) as unknown
    }
  }
}

/** The real gh CLI, without prompts. */
export const execGh: RunGh = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        // gh runs git to find the repository, so it gets the same clean environment.
        env: childEnv({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }),
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new GitHubError("Couldn't find the gh command. Install GitHub CLI and run gh auth login."))
          return
        }
        reject(new GitHubError(stderr.trim() || error.message))
      }
    )
  })
