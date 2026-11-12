// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The worker is
// stood in for by `requests`: what each plugin.request answers.
import { settings } from 'orca'
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { OpenOutcome, OpenTarget, StackView, SwitchOutcome, SwitchTarget } from './protocol'

let view: TestPanel | undefined
afterEach(() => view?.unmount())

function entry(number: number, title: string, branch: string, current = false) {
  return { number, title, url: `https://github.com/acme/widgets/pull/${number}`, branch, status: 'review needed', current }
}

/** The three-PR stack with the workspace on PR `current`. */
function stackOn(current: 11 | 12 | 13): StackView {
  const branches = { 11: 'feat/model', 12: 'feat/screen', 13: 'feat/wiring' } as const
  return {
    kind: 'stack',
    workspace: 'widgets',
    workspaceId: 'w1',
    branch: branches[current],
    pr: current,
    stack: {
      number: 10,
      size: 3,
      position: current - 10,
      base: 'main',
      entries: [
        entry(13, 'Wire it up', 'feat/wiring', current === 13),
        entry(12, 'Add the screen', 'feat/screen', current === 12),
        entry(11, 'Add the model', 'feat/model', current === 11)
      ]
    }
  }
}

/**
 * A worker that serves `views` in turn (the last one repeats), answers switches with `outcome` and
 * opening a PR in Orca's browser with each of `opened` in turn. A view may be a promise, to hold the
 * panel in its loading state. `openIn` is where the person chose to open PRs, in the plugin's settings.
 */
function worker(
  views: (StackView | Promise<StackView>)[],
  outcome?: SwitchOutcome,
  options: { openIn?: 'browser' | 'orca'; opened?: OpenOutcome[] } = {}
) {
  const switches: SwitchTarget[] = []
  const opens: OpenTarget[] = []
  const opened = options.opened ?? [{ kind: 'opened' }]
  let loads = 0
  const host = mockHost({
    settings: options.openIn ? { openPullRequestsIn: options.openIn } : {},
    requests: {
      'stack.load': () => views[Math.min(loads++, views.length - 1)]!,
      'stack.switch': (target: SwitchTarget) => {
        switches.push(target)
        return outcome ?? { kind: 'switched', branch: target.branch }
      },
      'stack.openInOrca': (target: OpenTarget) => {
        opens.push(target)
        return opened[Math.min(opens.length - 1, opened.length - 1)]!
      }
    }
  })
  return { host, switches, opens, loads: () => loads }
}

const switchIn = (number: number) => ({ testId: `pr-${number}`, role: 'button', text: 'Switch' }) as const
/** The PR's number in its row, which opens the PR. */
const numberOf = (number: number) => ({ type: 'Link', text: `#${number}` }) as const

test('lists the stack top-first with a Switch button on every PR but the current one', async () => {
  view = await mount(panel, { host: worker([stackOn(12)]).host })
  assert.ok(view.find({ text: /Stack #10/ }))
  assert.ok(view.find({ text: /2 of 3 · main/ }))
  assert.deepEqual(
    view.findAll({ type: 'Link', text: /^#1[123]$/ }).map((element) => element.text),
    ['#13', '#12', '#11']
  )
  assert.ok(view.find(switchIn(13)))
  assert.ok(view.find(switchIn(11)))
  assert.equal(view.find(switchIn(12)), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('switches to the PR whose button is pressed, then shows the stack from there', async () => {
  const fake = worker([stackOn(12), stackOn(13)])
  view = await mount(panel, { host: fake.host })
  await view.press(switchIn(13))
  assert.deepEqual(fake.switches, [
    { number: 13, branch: 'feat/wiring', url: 'https://github.com/acme/widgets/pull/13', workspaceId: 'w1' }
  ])
  assert.equal(view.find(switchIn(13)), null)
  assert.ok(view.find(switchIn(12)))
  assert.ok(view.find({ text: /Switched to feat\/wiring/ }))
})

test("opens a PR in the person's web browser when its number is pressed", async () => {
  const fake = worker([stackOn(12)])
  view = await mount(panel, { host: fake.host })
  await view.press(numberOf(13))
  assert.deepEqual(fake.host.callsOf('shell.openExternal'), [{ url: 'https://github.com/acme/widgets/pull/13' }])
  assert.deepEqual(fake.opens, [])
  assert.deepEqual(view.refusals, [])
})

test("opens a PR in Orca's browser when the plugin's settings say so", async () => {
  const fake = worker([stackOn(12)], undefined, { openIn: 'orca' })
  view = await mount(panel, { host: fake.host })
  await view.press(numberOf(11))
  assert.deepEqual(fake.opens, [{ url: 'https://github.com/acme/widgets/pull/11', workspaceId: 'w1' }])
  assert.deepEqual(fake.host.callsOf('shell.openExternal'), [])
})

test('opens PRs where the settings say as soon as the person changes them', async () => {
  const fake = worker([stackOn(12)])
  view = await mount(panel, { host: fake.host })
  await settings.set('openPullRequestsIn', 'orca')
  await view.settled()
  await view.press(numberOf(13))
  assert.deepEqual(fake.opens, [{ url: 'https://github.com/acme/widgets/pull/13', workspaceId: 'w1' }])
})

test("says why a PR didn't open in Orca's browser, with a way to open it in the web browser", async () => {
  const failed = { kind: 'failed', message: "Couldn't find the orca command that comes with Orca." } as const
  const fake = worker([stackOn(12)], undefined, { openIn: 'orca', opened: [failed] })
  view = await mount(panel, { host: fake.host })
  await view.press(numberOf(13))
  assert.ok(view.find({ type: 'Callout', text: /Couldn't find the orca command/ }), view.summary().join('\n'))
  await view.press({ type: 'Link', text: 'Open it in your web browser' })
  assert.deepEqual(fake.host.callsOf('shell.openExternal'), [{ url: 'https://github.com/acme/widgets/pull/13' }])
})

test("takes the warning away once a later press opens the PR in Orca's browser", async () => {
  const failed = { kind: 'failed', message: "Orca's runtime is still starting." } as const
  const fake = worker([stackOn(12)], undefined, { openIn: 'orca', opened: [failed, { kind: 'opened' }] })
  view = await mount(panel, { host: fake.host })
  await view.press(numberOf(13))
  assert.ok(view.find({ type: 'Callout', text: /still starting/ }))
  await view.press(numberOf(13))
  assert.equal(view.find({ type: 'Callout' }), null, view.summary().join('\n'))
})

test('says which workspace Orca moved to when another one had the branch', async () => {
  const fake = worker([stackOn(12), stackOn(13)], { kind: 'opened', workspace: 'wiring-ws', branch: 'feat/wiring' })
  view = await mount(panel, { host: fake.host })
  await view.press(switchIn(13))
  assert.ok(view.find({ text: /wiring-ws/ }))
})

test('shows why a switch was refused', async () => {
  const reason = 'This workspace has uncommitted changes in 2 files. Commit or stash them, then switch.'
  view = await mount(panel, { host: worker([stackOn(12)], { kind: 'refused', reason }).host })
  await view.press(switchIn(11))
  assert.ok(view.find({ type: 'Callout', text: new RegExp(reason) }))
})

test('shows what went wrong when a switch fails', async () => {
  const fake = worker([stackOn(12)], { kind: 'failed', message: "couldn't find remote ref refs/heads/feat/model" })
  view = await mount(panel, { host: fake.host })
  await view.press(switchIn(11))
  assert.ok(view.find({ type: 'Callout', text: /couldn't find remote ref/ }))
})

test('loads the stack again when another workspace comes into view', async () => {
  const fake = worker([stackOn(12), { kind: 'no-pr', workspace: 'other', branch: 'chore/docs' }])
  view = await mount(panel, { host: fake.host })
  await view.emit('workspace.changed', { context: { displayName: 'other', branch: 'chore/docs', terminals: [] } })
  assert.ok(view.find({ text: /chore\/docs/ }))
  assert.equal(view.find(switchIn(13)), null)
})

test('does not ask GitHub again when only the terminals change', async () => {
  const fake = worker([stackOn(12)])
  view = await mount(panel, { host: fake.host })
  const loadsBefore = fake.loads()
  await view.emit('workspace.changed', {
    context: { displayName: 'widgets', branch: 'feat/screen', terminals: [{ id: 't2', title: 'zsh' }] }
  })
  assert.equal(fake.loads(), loadsBefore)
})

/** A promise the test settles when it chooses. */
function later<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

test('keeps every Switch disabled while the stack reloads', async () => {
  // While another workspace's stack loads, these rows are not that workspace's.
  const reload = later<StackView>()
  view = await mount(panel, { host: worker([stackOn(12), reload.promise]).host })
  const refreshing = view.press({ role: 'button', label: 'Refresh' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(view.find(switchIn(13))?.disabled, true)
  assert.equal(view.find(switchIn(11))?.disabled, true)
  reload.settle(stackOn(12))
  await refreshing
  assert.equal(view.find(switchIn(13))?.disabled, false)
})

test('keeps the switch notice once Orca catches up with the new branch', async () => {
  const fake = worker([stackOn(12), stackOn(13)])
  view = await mount(panel, { host: fake.host })
  await view.press(switchIn(13))
  const loadsAfterSwitch = fake.loads()
  // Orca also renames a workspace it had named after its branch.
  await view.emit('workspace.changed', { context: { displayName: 'feat/wiring', branch: 'feat/wiring', terminals: [] } })
  assert.ok(view.find({ text: /Switched to feat\/wiring/ }))
  assert.equal(fake.loads(), loadsAfterSwitch)
})

test('asks GitHub again only when the workspace or branch changes, even while showing an error', async () => {
  const fake = worker([{ kind: 'error', message: 'gh auth login required' }])
  view = await mount(panel, { host: fake.host })
  const context = { displayName: 'widgets', branch: 'main', terminals: [] }
  await view.emit('workspace.changed', { context })
  const loads = fake.loads()
  await view.emit('workspace.changed', { context: { ...context, terminals: [{ id: 't2', title: 'claude' }] } })
  await view.emit('workspace.changed', { context })
  assert.equal(fake.loads(), loads)
})

test('clears an old notice once another workspace comes into view', async () => {
  const refusal = { kind: 'refused', reason: 'An agent in this workspace is still working.' } as const
  const fake = worker([stackOn(12), stackOn(12), { kind: 'no-pr', workspace: 'other', branch: 'chore/docs' }], refusal)
  view = await mount(panel, { host: fake.host })
  await view.press(switchIn(13))
  assert.ok(view.find({ text: /still working/ }))
  await view.emit('workspace.changed', { context: { displayName: 'other', branch: 'chore/docs', terminals: [] } })
  assert.equal(view.find({ text: /still working/ }), null)
})

test('reloads when the refresh button is pressed', async () => {
  const fake = worker([stackOn(12), stackOn(11)])
  view = await mount(panel, { host: fake.host })
  await view.press({ role: 'button', label: 'Refresh' })
  assert.equal(view.find(switchIn(11)), null)
  assert.ok(view.find(switchIn(12)))
})

const emptyStates: [string, StackView, RegExp][] = [
  ['no workspace', { kind: 'no-workspace' }, /Open a workspace/],
  ['a detached HEAD', { kind: 'no-branch', workspace: 'widgets' }, /not on a branch/],
  ['a branch without a PR', { kind: 'no-pr', workspace: 'widgets', branch: 'chore/docs' }, /chore\/docs has no pull request/],
  ['a PR outside any stack', { kind: 'no-stack', workspace: 'widgets', branch: 'fix/typo', pr: 7 }, /#7 isn't part of a stack/],
  ['a workspace on another machine', { kind: 'other-host', workspace: 'devbox' }, /devbox is on another machine/],
  [
    'workspaces it cannot tell apart',
    { kind: 'ambiguous', workspace: 'main', branch: 'main' },
    /Several workspaces are named "main".*Rename this one/
  ]
]

for (const [name, state, says] of emptyStates) {
  test(`explains ${name}`, async () => {
    view = await mount(panel, { host: worker([state]).host })
    assert.ok(view.find({ text: says }), view.summary().join('\n'))
    assert.equal(view.find({ role: 'button', text: 'Switch' }), null)
  })
}

test('shows a load error with a way to try again', async () => {
  const fake = worker([{ kind: 'error', message: 'gh auth login required' }, stackOn(12)])
  view = await mount(panel, { host: fake.host })
  assert.ok(view.find({ type: 'Callout', text: /gh auth login required/ }))
  await view.press({ role: 'button', text: 'Try again' })
  assert.ok(view.find(switchIn(13)))
})
