import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import {
  currentBranch,
  GitError,
  gitTimeouts,
  hasLocalBranch,
  isValidBranchName,
  remoteFor,
  switchBranch,
  uncommittedFiles,
  worktreeWithBranch
} from './git'
import { commit, git, makeStackRepos, pointAtGitHub, wrapGit, type StackRepos } from './test-repos'

let repos: StackRepos
beforeEach(() => {
  repos = makeStackRepos()
})
afterEach(() => repos.dispose())

test('leaves no temp folder behind when setting up the test repositories fails', () => {
  const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('stack-switcher-test-')).length
  const before = leftovers()
  const restore = wrapGit(repos.root, '[ "$1" = push ] && { echo "push refused" >&2; exit 1; }')
  try {
    assert.throws(() => makeStackRepos(), /push refused/)
  } finally {
    restore()
  }
  assert.equal(leftovers(), before)
})

test('reads the branch the worktree is on', async () => {
  assert.equal(await currentBranch(repos.clone), 'main')
})

test("stays in its own repositories when a git hook exported another repository's GIT_DIR", async () => {
  // `npm test` from a pre-commit hook, or `git rebase -x 'npm test'`, inherits these.
  const victim = join(repos.root, 'victim')
  git(repos.root, 'init', '--quiet', '--initial-branch=trunk', victim)
  commit(victim, 'mine.txt', 'mine')
  process.env.GIT_DIR = join(victim, '.git')
  process.env.GIT_WORK_TREE = victim
  try {
    const more = makeStackRepos()
    try {
      assert.equal(await currentBranch(more.clone), 'main')
    } finally {
      more.dispose()
    }
  } finally {
    delete process.env.GIT_DIR
    delete process.env.GIT_WORK_TREE
  }
  assert.equal(git(victim, 'branch', '--format=%(refname:short)'), 'trunk')
  assert.equal(git(victim, 'rev-list', '--count', 'HEAD'), '1')
})

test('reads no branch on a detached HEAD', async () => {
  git(repos.clone, 'switch', '--quiet', '--detach')
  assert.equal(await currentBranch(repos.clone), null)
})

test('lists changed and new files, but not ignored ones', async () => {
  assert.deepEqual(await uncommittedFiles(repos.clone), [])
  writeFileSync(join(repos.clone, 'README.md'), 'changed')
  writeFileSync(join(repos.clone, 'notes.txt'), 'new')
  writeFileSync(join(repos.clone, '.gitignore'), 'build.log\n')
  writeFileSync(join(repos.clone, 'build.log'), 'ignored')
  assert.deepEqual((await uncommittedFiles(repos.clone)).sort(), ['.gitignore', 'README.md', 'notes.txt'])
})

test('counts a renamed file once, by its new name', async () => {
  git(repos.clone, 'mv', 'README.md', 'GUIDE.md')
  assert.deepEqual(await uncommittedFiles(repos.clone), ['GUIDE.md'])
})

test('counts new files even where git is set to hide them', async () => {
  git(repos.clone, 'config', 'status.showUntrackedFiles', 'no')
  writeFileSync(join(repos.clone, 'notes.txt'), 'new')
  assert.deepEqual(await uncommittedFiles(repos.clone), ['notes.txt'])
})

test('does not count a submodule that a switch left at another commit, but counts a staged one', async () => {
  // lib is at v1 on main; feat/bump moves it to v2. A switch never updates submodules by itself.
  const lib = join(repos.root, 'lib')
  git(repos.root, 'init', '--quiet', '--initial-branch=main', lib)
  commit(lib, 'version.txt', 'v1')
  git(repos.clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', lib, 'lib')
  git(repos.clone, 'commit', '--quiet', '-m', 'Add lib at v1')
  commit(lib, 'version.txt', 'v2')
  git(repos.clone, 'switch', '--quiet', '--create', 'feat/bump')
  git(join(repos.clone, 'lib'), 'pull', '--quiet', 'origin', 'main')
  git(repos.clone, 'commit', '--quiet', '-am', 'Bump lib to v2')
  git(repos.clone, 'switch', '--quiet', 'main')
  // `git` trims, so git's " M lib" (changed in the worktree, not staged) reads "M lib".
  assert.equal(git(repos.clone, 'status', '--porcelain'), 'M lib')
  assert.deepEqual(await uncommittedFiles(repos.clone), [])
  git(repos.clone, 'add', 'lib')
  assert.deepEqual(await uncommittedFiles(repos.clone), ['lib'])
})

test('lists a file renamed in the worktree under its new name', async () => {
  git(repos.clone, 'mv', 'README.md', 'GUIDE.md')
  git(repos.clone, 'reset', '--quiet')
  git(repos.clone, 'add', '--intent-to-add', 'GUIDE.md')
  assert.deepEqual((await uncommittedFiles(repos.clone)).sort(), ['GUIDE.md'])
})

test('knows which branches exist locally', async () => {
  assert.equal(await hasLocalBranch(repos.clone, 'main'), true)
  // Only origin/feat/screen exists in a fresh clone.
  assert.equal(await hasLocalBranch(repos.clone, 'feat/screen'), false)
})

test('finds the worktree a branch is checked out in', async () => {
  const other = join(repos.root, 'screen-worktree')
  git(repos.clone, 'worktree', 'add', '--quiet', other, 'feat/screen')
  assert.equal(await worktreeWithBranch(repos.clone, 'feat/screen'), other)
  assert.equal(await worktreeWithBranch(repos.clone, 'main'), repos.clone)
  assert.equal(await worktreeWithBranch(repos.clone, 'feat/model'), null)
})

test('finds worktrees with git older than 2.36, which has no `worktree list -z`', async () => {
  const other = join(repos.root, 'screen-worktree')
  git(repos.clone, 'worktree', 'add', '--quiet', other, 'feat/screen')
  // As git 2.34 (Ubuntu 22.04) answers.
  const restore = wrapGit(
    repos.root,
    `if [ "$1" = worktree ]; then for arg in "$@"; do [ "$arg" = -z ] && { echo "error: unknown switch \\\`z'" >&2; exit 129; }; done; fi`
  )
  try {
    assert.equal(await worktreeWithBranch(repos.clone, 'feat/screen'), other)
  } finally {
    restore()
  }
})

const onGitHub = (owner: string, repo: string) => ({ host: 'github.com', owner, repo })

test('picks the remote that points at the GitHub repository', async () => {
  git(repos.clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
  git(repos.clone, 'remote', 'add', 'upstream', 'https://github.com/Other-Org/widgets')
  git(repos.clone, 'remote', 'add', 'alias', 'git@github-work:team/tools.git')
  assert.equal(await remoteFor(repos.clone, onGitHub('acme', 'widgets')), 'origin')
  assert.equal(await remoteFor(repos.clone, onGitHub('other-org', 'widgets')), 'upstream')
  // An SSH host alias from ~/.ssh/config: the path still names the repository.
  assert.equal(await remoteFor(repos.clone, onGitHub('team', 'tools')), 'alias')
  assert.equal(await remoteFor(repos.clone, onGitHub('acme', 'gadgets')), null)
})

test('prefers the GitHub remote over a mirror of the same repository elsewhere', async () => {
  git(repos.clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
  // Listed first: git lists remotes in alphabetical order.
  git(repos.clone, 'remote', 'add', 'gitlab', 'git@gitlab.com:acme/widgets.git')
  assert.equal(await remoteFor(repos.clone, onGitHub('acme', 'widgets')), 'origin')
})

test('finds the remote of a partial clone, whose listing ends in its filter', async () => {
  git(repos.clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
  git(repos.clone, 'config', 'remote.origin.promisor', 'true')
  git(repos.clone, 'config', 'remote.origin.partialclonefilter', 'blob:none')
  assert.equal(await remoteFor(repos.clone, onGitHub('acme', 'widgets')), 'origin')
})

test('uses the only GitHub remote when the repository was renamed since it was cloned', async () => {
  // GitHub redirects the old name, and PR links use the new one.
  git(repos.clone, 'remote', 'set-url', 'origin', 'https://github.com/old-org/widgets.git')
  assert.equal(await remoteFor(repos.clone, onGitHub('new-org', 'widgets')), 'origin')
})

test('accepts real branch names and refuses option-like or malformed ones', async () => {
  assert.equal(await isValidBranchName(repos.clone, 'feat/model'), true)
  assert.equal(await isValidBranchName(repos.clone, '-x'), false)
  assert.equal(await isValidBranchName(repos.clone, 'a..b'), false)
  assert.equal(await isValidBranchName(repos.clone, ''), false)
  // Git expands @{-1} to the previous branch; switching to it would land somewhere else.
  git(repos.clone, 'switch', '--quiet', '--create', 'scratch')
  assert.equal(await isValidBranchName(repos.clone, '@{-1}'), false)
})

test('switches to a branch that exists locally', async () => {
  git(repos.clone, 'branch', '--quiet', '--track', 'feat/model', 'origin/feat/model')
  await switchBranch(repos.clone, 'feat/model', 'origin')
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'feat/model')
})

test('fetches a branch that is only on the remote and tracks it', async () => {
  // A branch pushed after this clone last fetched.
  const seed = join(repos.root, 'seed')
  git(seed, 'switch', '--quiet', '--create', 'feat/late', 'feat/wiring')
  git(seed, 'push', '--quiet', 'origin', 'feat/late')
  await switchBranch(repos.clone, 'feat/late', 'origin')
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'feat/late')
  assert.equal(git(repos.clone, 'rev-parse', '--abbrev-ref', 'feat/late@{upstream}'), 'origin/feat/late')
})

test('fetches and tracks a branch in a single-branch clone', async () => {
  // `--single-branch` and `--depth` clones only map main into refs/remotes.
  const single = join(repos.root, 'single')
  git(repos.root, 'clone', '--quiet', '--single-branch', '--branch', 'main', repos.remote, single)
  pointAtGitHub(single, repos.remote)
  await switchBranch(single, 'feat/screen', 'origin')
  assert.equal(git(single, 'branch', '--show-current'), 'feat/screen')
  assert.equal(git(single, 'status', '--porcelain'), '')
  assert.equal(git(single, 'config', 'branch.feat/screen.remote'), 'origin')
  assert.equal(git(single, 'config', 'branch.feat/screen.merge'), 'refs/heads/feat/screen')
})

test('never stops a slow checkout part-way through', async () => {
  // A smudge filter (as Git LFS uses) that takes longer than git's usual time limit.
  git(repos.clone, 'config', 'filter.slow.smudge', 'sleep 2; cat')
  writeFileSync(join(repos.clone, '.git', 'info', 'attributes'), '*.txt filter=slow\n')
  const usual = gitTimeouts.quick
  gitTimeouts.quick = 1_000
  try {
    await switchBranch(repos.clone, 'feat/model', 'origin')
  } finally {
    gitTimeouts.quick = usual
  }
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'feat/model')
  assert.equal(git(repos.clone, 'status', '--porcelain'), '')
})

test('reports what git said when a switch fails', async () => {
  await assert.rejects(
    () => switchBranch(repos.clone, 'feat/missing', 'origin'),
    (error: unknown) => error instanceof GitError && /feat\/missing/.test(error.message)
  )
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'main')
})
