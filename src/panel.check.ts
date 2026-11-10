// `orca plugin check` renders the panel once per scenario. Each stubs the worker's answers, so
// check never runs git or gh against a real repository.
import { defineCheck } from 'orca/testing'
import type { StackView } from './protocol'

const entry = (number: number, title: string, branch: string, status: string, current = false) => ({
  number,
  title,
  url: `https://github.com/acme/widgets/pull/${number}`,
  branch,
  status,
  current
})

const stack: StackView = {
  kind: 'stack',
  workspace: 'widgets',
  workspaceId: 'w1',
  branch: 'feat/screen-state',
  pr: 104,
  stack: {
    number: 101,
    size: 4,
    position: 3,
    base: 'main',
    entries: [
      entry(105, 'Wire the new screen into navigation and deep links', 'feat/screen-nav', 'checks pending'),
      entry(104, 'Keep the screen state in one controller', 'feat/screen-state', 'checks pending', true),
      entry(103, 'Add the screen behind a flag', 'feat/screen', 'approved'),
      entry(102, 'Add the model the screen reads', 'feat/model', 'conflicts')
    ]
  }
}

const answering = (view: StackView) => ({ requests: { 'stack.load': () => view } })

export default defineCheck({
  stack: answering(stack),
  noWorkspace: answering({ kind: 'no-workspace' }),
  noPullRequest: answering({ kind: 'no-pr', workspace: 'widgets', branch: 'chore/docs' }),
  notStacked: answering({ kind: 'no-stack', workspace: 'widgets', branch: 'fix/typo', pr: 99 }),
  lookAlikes: answering({ kind: 'ambiguous', workspace: 'main', branch: 'main' }),
  otherHost: answering({ kind: 'other-host', workspace: 'devbox-widgets' }),
  loadError: answering({ kind: 'error', message: 'To get started with GitHub CLI, please run: gh auth login' })
})
