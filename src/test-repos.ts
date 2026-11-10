// Test helper only: real, throwaway git repositories under the OS temp folder.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from './env'

/** Fixed identity, no user or system config: the same repositories on every machine. */
const TEST_GIT_VARIABLES = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: childEnv(TEST_GIT_VARIABLES), encoding: 'utf8', stdio: 'pipe' }).trim()
}

export type StackRepos = {
  /** Holds everything; remove it with `dispose`. */
  root: string
  /** The bare repository the clone fetches from, as GitHub's acme/widgets would be. */
  remote: string
  /**
   * A clone on `main` whose only local branch is `main`. Its origin is
   * https://github.com/acme/widgets.git, which git's `insteadOf` sends to `remote`.
   */
  clone: string
  dispose(): void
}

/** A remote holding a three-branch stack on `main`: feat/model <- feat/screen <- feat/wiring. */
export function makeStackRepos(): StackRepos {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stack-switcher-test-')))
  const dispose = () => rmSync(root, { recursive: true, force: true })
  const remote = join(root, 'acme', 'widgets.git')
  const seed = join(root, 'seed')
  const clone = join(root, 'clone')
  try {
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote)
    git(root, 'clone', '--quiet', remote, seed)
    git(seed, 'switch', '--quiet', '--create', 'main')
    commit(seed, 'README.md', 'hello')
    for (const branch of ['feat/model', 'feat/screen', 'feat/wiring']) {
      git(seed, 'switch', '--quiet', '--create', branch)
      commit(seed, `${branch.replace('/', '-')}.txt`, branch)
    }
    git(seed, 'push', '--quiet', '--all', 'origin')
    git(root, 'clone', '--quiet', '--branch', 'main', remote, clone)
    pointAtGitHub(clone, remote)
  } catch (error) {
    dispose() // Nobody gets a `dispose` for a setup that failed.
    throw error
  }
  return { root, remote, clone, dispose }
}

/** Makes `clone`'s origin read as GitHub's acme/widgets while git still fetches from `remote`. */
export function pointAtGitHub(clone: string, remote: string): void {
  git(clone, 'remote', 'set-url', 'origin', GITHUB_URL)
  git(clone, 'config', `url.${remote}.insteadOf`, GITHUB_URL)
}

const GITHUB_URL = 'https://github.com/acme/widgets.git'

/**
 * Puts a stand-in `git` first on PATH for code under test: `script` is a shell snippet run before
 * handing over to the real git with `exec "$REAL_GIT" "$@"`. Returns the function that undoes it.
 */
export function wrapGit(root: string, script: string): () => void {
  const bin = join(root, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nREAL_GIT='${realGit}'\n${script}\nexec "$REAL_GIT" "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  const before = process.env.PATH
  process.env.PATH = `${bin}:${before ?? ''}`
  return () => {
    process.env.PATH = before
  }
}

export function commit(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '--quiet', '-m', `Add ${file}`)
}
