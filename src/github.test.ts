import { assert, test } from 'orca/testing'
import { createGitHub, GitHubError, type RunGh } from './github'
import { threePrStack } from './test-fixtures'

/** Stands in for the gh CLI: answers only the exact commands listed, as gh prints them. */
function fakeGh(answers: { args: string[]; stdout?: string; fails?: string }[]): RunGh {
  return async (args, cwd) => {
    assert.equal(cwd, '/code/widgets')
    const answer = answers.find((candidate) => JSON.stringify(candidate.args) === JSON.stringify(args))
    if (!answer) throw new Error(`unexpected gh call: gh ${args.join(' ')}`)
    if (answer.fails !== undefined) throw new GitHubError(answer.fails)
    return answer.stdout ?? ''
  }
}

/** `gh pr list` for the PRs whose head is `branch`, in `repo` when given (else gh picks). */
const prList = (branch: string, repo?: string) => [
  'pr',
  'list',
  '--head',
  branch,
  '--state',
  'all',
  '--json',
  'number,url,state',
  '--limit',
  '20',
  ...(repo ? ['--repo', repo] : [])
]

const pr = (number: number, state = 'OPEN', repo = 'acme/widgets') => ({
  number,
  state,
  url: `https://github.com/${repo}/pull/${number}`
})

test('finds the PR for a branch and the repository it is in', async () => {
  const github = createGitHub(fakeGh([{ args: prList('feat/wiring'), stdout: JSON.stringify([pr(13)]) + '\n' }]))
  assert.deepEqual(await github.findPullRequest('/code/widgets', 'feat/wiring'), {
    number: 13,
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets'
  })
})

test('answers null for a branch that has no PR', async () => {
  const github = createGitHub(fakeGh([{ args: prList('feat/new'), stdout: '[]\n' }]))
  assert.equal(await github.findPullRequest('/code/widgets', 'feat/new'), null)
})

test('looks a branch named like a number up by name, not as a PR number', async () => {
  // `gh pr view 1234` would fetch PR #1234; only the branch named "1234" is meant.
  const github = createGitHub(fakeGh([{ args: prList('1234'), stdout: '[]' }]))
  assert.equal(await github.findPullRequest('/code/widgets', '1234'), null)
})

test('picks the open PR when the branch has had a closed one too', async () => {
  const github = createGitHub(fakeGh([{ args: prList('feat/wiring'), stdout: JSON.stringify([pr(30, 'CLOSED'), pr(31)]) }]))
  assert.equal((await github.findPullRequest('/code/widgets', 'feat/wiring'))?.number, 31)
})

test('asks the repository it is told to, on github.com or another host', async () => {
  const github = createGitHub(
    fakeGh([
      { args: prList('feat/wiring', 'acme-corp/widgets'), stdout: JSON.stringify([pr(13, 'OPEN', 'acme-corp/widgets')]) },
      { args: prList('feat/x', 'ghe.example.com/team/tools'), stdout: '[]' }
    ])
  )
  const onGitHub = { host: 'github.com', owner: 'acme-corp', repo: 'widgets' }
  assert.equal((await github.findPullRequest('/code/widgets', 'feat/wiring', onGitHub))?.owner, 'acme-corp')
  const onEnterprise = { host: 'ghe.example.com', owner: 'team', repo: 'tools' }
  assert.equal(await github.findPullRequest('/code/widgets', 'feat/x', onEnterprise), null)
})

const noGitHubRemote: [string, string][] = [
  ['no remote at all', 'no git remotes found'],
  [
    'only remotes on other hosts',
    'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`'
  ]
]

for (const [name, said] of noGitHubRemote) {
  test(`answers null for a repository with ${name}, since it can have no PR`, async () => {
    const github = createGitHub(fakeGh([{ args: prList('main'), fails: said }]))
    assert.equal(await github.findPullRequest('/code/widgets', 'main'), null)
  })
}

test('passes on any other gh failure', async () => {
  const github = createGitHub(
    fakeGh([{ args: prList('feat/wiring'), fails: 'To get started with GitHub CLI, please run:  gh auth login' }])
  )
  await assert.rejects(() => github.findPullRequest('/code/widgets', 'feat/wiring'), /gh auth login/)
})

test('says what to do when gh is not signed in where plugins can see it', async () => {
  // A GH_TOKEN set only in the shell never reaches Orca's plugins.
  const github = createGitHub(fakeGh([{ args: prList('feat/wiring'), fails: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }]))
  await assert.rejects(
    () => github.findPullRequest('/code/widgets', 'feat/wiring'),
    (error: unknown) =>
      error instanceof Error && /Bad credentials/.test(error.message) && /gh auth login in a terminal/.test(error.message)
  )
})

test("asks GitHub for that PR's stack", async () => {
  let asked: string[] = []
  const github = createGitHub(async (args) => {
    asked = args
    return JSON.stringify(threePrStack())
  })
  const answer = await github.fetchStack('/code/widgets', { number: 12, host: 'github.com', owner: 'acme', repo: 'widgets' })
  assert.deepEqual(answer, threePrStack())
  assert.deepEqual(asked.slice(0, 2), ['api', 'graphql'])
  assert.ok(asked.includes('owner=acme') && asked.includes('repo=widgets') && asked.includes('pr=12'))
  assert.ok(asked.some((arg) => arg.startsWith('query=') && arg.includes('stack')))
  assert.equal(asked.includes('--hostname'), false)
})

test('asks a GitHub Enterprise host for its own PRs', async () => {
  let asked: string[] = []
  const github = createGitHub(async (args) => {
    if (args[0] === 'pr') return '[{"number":5,"state":"OPEN","url":"https://ghe.example.com/team/tools/pull/5"}]'
    asked = args
    return JSON.stringify(threePrStack())
  })
  const pr = await github.findPullRequest('/code/widgets', 'feat/x')
  assert.deepEqual(pr, { number: 5, host: 'ghe.example.com', owner: 'team', repo: 'tools' })
  await github.fetchStack('/code/widgets', pr!)
  assert.deepEqual(asked.slice(asked.indexOf('--hostname'), asked.indexOf('--hostname') + 2), ['--hostname', 'ghe.example.com'])
})
