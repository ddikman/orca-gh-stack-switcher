// The plugin's worker: a Node process Orca starts when the panel first asks for something. It
// runs git and gh in the open workspace's folder and answers the panel (see src/protocol.ts).
import type { OrcaWorkerApi } from 'orca/worker'
import { createGitHub, execGh } from './github'
import { execOrca, openInOrca } from './orca-browser'
import type { OpenOutcome, SwitchOutcome, SwitchTarget } from './protocol'
import { loadStack, switchTo, type SwitcherDeps } from './switcher'

function isSwitchTarget(input: unknown): input is SwitchTarget {
  const target = input as Partial<SwitchTarget> | null
  return (
    typeof target?.number === 'number' &&
    typeof target.branch === 'string' &&
    typeof target.url === 'string' &&
    typeof target.workspaceId === 'string'
  )
}

export default function activate(orca: OrcaWorkerApi): void {
  const deps: SwitcherDeps = {
    host: {
      readContext: () => orca.host.call('workspace.readContext'),
      listWorkspaces: async () => (await orca.host.call('workspace.list')).workspaces,
      openWorkspace: async (workspaceId) => {
        await orca.host.call('workspace.open', { workspaceId })
      },
      listAgents: async () => (await orca.host.call('agents.list')).agents
    },
    github: createGitHub(execGh)
  }

  orca.panels.handle('stack.load', async () => {
    const view = await loadStack(deps)
    if (view.kind === 'error') orca.log(`load: ${view.message}`)
    return view
  })

  // One switch at a time: a second press while git is busy would race the first.
  let switching = false
  orca.panels.handle('stack.switch', async (input): Promise<SwitchOutcome> => {
    if (!isSwitchTarget(input)) {
      return { kind: 'refused', reason: 'The panel asked for a switch without a PR to switch to.' }
    }
    if (switching) {
      return { kind: 'refused', reason: 'Already switching. Wait for that to finish.' }
    }
    switching = true
    try {
      const outcome = await switchTo(deps, input)
      if (outcome.kind === 'failed') orca.log(`switch to ${input.branch}: ${outcome.message}`)
      return outcome
    } finally {
      switching = false
    }
  })

  orca.panels.handle('stack.openInOrca', async (input): Promise<OpenOutcome> => {
    const outcome = await openInOrca(deps.host.listWorkspaces, execOrca, input)
    if (outcome.kind === 'failed') orca.log(`open in Orca: ${outcome.message}`)
    return outcome
  })
}
