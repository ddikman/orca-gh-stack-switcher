// The orca command is stood in for, by a function that records what it is asked or by small
// scripts in a throwaway folder, so these tests never open a tab in the Orca that runs them.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import { openInOrca, orcaCommand, OrcaCliError, runOrcaCli, type RunOrca } from './orca-browser'
import type { ListedWorkspace } from './workspace'

const url = 'https://github.com/acme/widgets/pull/13'

/** Orca's list: the stack's workspace here (w1) and a look-alike on an SSH host (w2). */
const listWorkspaces = async (): Promise<ListedWorkspace[]> => [
  { id: 'w1', kind: 'worktree', name: 'widgets', path: '/code/widgets', branch: 'feat/screen', hostId: 'local' },
  { id: 'w2', kind: 'worktree', name: 'widgets', path: '/srv/widgets', branch: 'feat/screen', hostId: 'devbox' }
]

/** Stands in for the orca command: records each call and answers with `answer`. */
function fakeOrca(answer: () => string = () => '') {
  const calls: string[][] = []
  const run: RunOrca = async (args) => {
    calls.push(args)
    return answer()
  }
  return { run, calls }
}

test("opens the PR in a new browser tab of the stack's workspace", async () => {
  const orca = fakeOrca()
  assert.deepEqual(await openInOrca(listWorkspaces, orca.run, { url, workspaceId: 'w1' }), { kind: 'opened' })
  assert.deepEqual(orca.calls, [['tab', 'create', '--url', url, '--worktree', 'path:/code/widgets']])
})

test('says what orca said when it could not open the tab', async () => {
  const orca = fakeOrca(() => {
    throw new OrcaCliError('This host does not support browser panes.')
  })
  assert.deepEqual(await openInOrca(listWorkspaces, orca.run, { url, workspaceId: 'w1' }), {
    kind: 'failed',
    message: 'This host does not support browser panes.'
  })
})

test('opens nothing for a workspace on another machine, or one Orca no longer lists', async () => {
  const orca = fakeOrca()
  for (const workspaceId of ['w2', 'w9']) {
    assert.equal((await openInOrca(listWorkspaces, orca.run, { url, workspaceId })).kind, 'failed')
  }
  assert.deepEqual(orca.calls, [])
})

test('hands orca nothing but a web address', async () => {
  const orca = fakeOrca()
  const outcome = await openInOrca(listWorkspaces, orca.run, { url: 'file:///etc/passwd', workspaceId: 'w1' })
  assert.equal(outcome.kind, 'failed')
  assert.deepEqual(orca.calls, [])
})

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'stack-switcher-orca-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** A stand-in orca command at `name` in the throwaway folder: a shell script that runs `body`. */
function script(name: string, body: string): string {
  const path = join(folder, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test('hands orca each argument as it is, and asks for its JSON answer', async () => {
  const orca = script('orca', `printf '%s\\n' "$@"`)
  const odd = `${url}?a=1&b=$(id) 'quoted'`
  assert.equal(await runOrcaCli(orca)(['tab', 'create', '--url', odd]), `tab\ncreate\n--url\n${odd}\n--json\n`)
})

/** What orca 1.4.256 prints, with --json, when no workspace matches the selector. */
const NO_MATCH = {
  id: '1ac399b1-8d8f-4f3e-970b-df5fde9bde2c',
  ok: false,
  error: {
    code: 'selector_not_found',
    message: 'selector_not_found',
    data: {
      selector: 'path:/code/gone',
      validSelectorForms: ['id:<repo-id>::<absolute-path>', 'folder:<folder-id>', 'path:<absolute-path>', 'current', 'active'],
      suggestions: [],
      nextSteps: [
        'No Orca workspace matched the worktree selector "path:/code/gone".',
        'Valid selector forms: id:<repo-id>::<absolute-path>, folder:<folder-id>, path:<absolute-path>, current, active.',
        'List the exact values, folder workspaces included, with `orca worktree ps --json`.'
      ]
    }
  },
  _meta: { runtimeId: '661ff2e2-949c-4651-8ce6-5f2415efcc42' }
}

test('tells the first next step orca gave when it could not do what it was asked', async () => {
  writeFileSync(join(folder, 'answer.json'), JSON.stringify(NO_MATCH, null, 2))
  const orca = script('orca', `cat '${join(folder, 'answer.json')}'; exit 1`)
  await assert.rejects(
    runOrcaCli(orca)(['tab', 'create']),
    (error: unknown) =>
      error instanceof OrcaCliError &&
      error.message === 'No Orca workspace matched the worktree selector "path:/code/gone".'
  )
})

const unanswered: [string, string, RegExp][] = [
  // orca's own launcher says this on stdout when it can't find Orca.app.
  ['its launcher could not find Orca', `echo 'Unable to determine Orca.app path from symlink: orca'; exit 1`, /Unable to determine Orca\.app path/],
  ['it crashed', `echo 'TypeError: cannot read properties of undefined' >&2; exit 1`, /TypeError: cannot read properties/]
]

for (const [when, body, says] of unanswered) {
  test(`tells what orca printed when ${when}`, async () => {
    await assert.rejects(runOrcaCli(script('orca', body))(['tab', 'create']), says)
  })
}

test("says it can't find orca when there is no such command", async () => {
  await assert.rejects(runOrcaCli(join(folder, 'missing'))(['tab', 'create']), /Couldn't find/)
})

test('uses the orca command that comes with the Orca running the worker, else the one on PATH', () => {
  mkdirSync(join(folder, 'bin'))
  script(join('bin', 'orca'), 'exit 0')
  assert.equal(orcaCommand(folder), join(folder, 'bin', 'orca'))
  assert.equal(orcaCommand(join(folder, 'elsewhere')), 'orca')
  assert.equal(orcaCommand(undefined), 'orca')
})
