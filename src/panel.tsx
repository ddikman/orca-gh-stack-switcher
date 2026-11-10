// The Stack panel. No build step: Orca strips the types and compiles the JSX when it loads.
// It draws what the worker (src/worker.ts) answers; the worker does the git and gh work.
import {
  atom,
  Box,
  Button,
  Callout,
  EmptyState,
  IconButton,
  on,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import { createContextTracker } from './context-tracker'
import type { StackView, SwitchOutcome } from './protocol'
import type { StackEntry } from './stack'

type Notice = {
  tone: 'neutral' | 'accent' | 'warning' | 'danger'
  title?: string
  text: string
  /** The branches it is about: it stays while the panel shows one of them. */
  keepFor: string[]
}

/** Pixels: an extra-small "Switch" button (about 57) with room to spare. */
const SWITCH_SLOT_WIDTH = 64

/** What the worker last answered; null until the first answer. */
const view = atom<StackView | null>(null)
const loading = atom(false)
/** The PR a switch is running for, if any. */
const switchingTo = atom<number | null>(null)
/** The outcome of the last switch, until the next one or a workspace change. */
const notice = atom<Notice | null>(null)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Decides which of Orca's workspace events need a load; made fresh for each panel run. */
let tracker = createContextTracker()
let latestLoad = 0

const branchShown = (shown: StackView): string | null => ('branch' in shown ? shown.branch : null)

async function load(): Promise<void> {
  const ticket = ++latestLoad
  set(loading, true)
  let answer: StackView
  try {
    answer = await plugin.request('stack.load', undefined, { timeoutMs: 60_000 })
  } catch (error) {
    answer = { kind: 'error', message: messageOf(error) }
  }
  // An older load that finishes late must not replace a newer answer.
  if (ticket !== latestLoad) return
  set(view, answer)
  set(loading, false)
  const branch = branchShown(answer)
  tracker.loaded('workspace' in answer && branch !== null ? { displayName: answer.workspace, branch } : null)
  const shownNotice = read(notice)
  if (shownNotice && (branch === null || !shownNotice.keepFor.includes(branch))) {
    set(notice, null) // The person has moved on to another workspace or branch.
  }
}

function noticeFor(outcome: SwitchOutcome, fromBranch: string | null): Notice {
  const here = fromBranch ? [fromBranch] : []
  switch (outcome.kind) {
    case 'switched':
      return {
        tone: outcome.note ? 'warning' : 'neutral',
        text: outcome.note ? `Switched to ${outcome.branch}. ${outcome.note}` : `Switched to ${outcome.branch}.`,
        keepFor: [outcome.branch]
      }
    case 'opened':
      return {
        tone: 'accent',
        text: `${outcome.branch} is checked out in the workspace "${outcome.workspace}", so Orca opened that one.`,
        // Orca may show the other workspace a moment after the panel reloads.
        keepFor: [outcome.branch, ...here]
      }
    case 'refused':
      return { tone: 'warning', title: "Didn't switch", text: outcome.reason, keepFor: here }
    case 'failed':
      return { tone: 'danger', title: 'Switch failed', text: outcome.message, keepFor: here }
  }
}

async function switchTo(entry: StackEntry): Promise<void> {
  const shown = read(view)
  if (!entry.branch || read(switchingTo) !== null || read(loading) || shown?.kind !== 'stack') return
  set(switchingTo, entry.number)
  set(notice, null)
  let outcome: SwitchOutcome
  try {
    outcome = await plugin.request(
      'stack.switch',
      { number: entry.number, branch: entry.branch, url: entry.url, workspaceId: shown.workspaceId },
      { timeoutMs: 120_000 }
    )
  } catch (error) {
    outcome = { kind: 'failed', message: messageOf(error) }
  }
  if (outcome.kind === 'switched') {
    tracker.switchedTo(outcome.branch) // Orca reports the new branch a moment later.
  }
  set(notice, noticeFor(outcome, shown.branch))
  set(switchingTo, null)
  await load()
}

export function setup(ctx: PanelContext): void {
  tracker = createContextTracker()
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      if (tracker.needsLoad(context)) {
        void load()
      }
    })
  )
  void load()
}

function EntryRow({ entry }: { entry: StackEntry }) {
  const busy = read(switchingTo)
  // While a load runs, these rows may be another workspace's: nothing can be switched.
  const isLoading = read(loading)
  return (
    <Box
      key={`row-${entry.number}`}
      direction="row"
      align="center"
      gap="sm"
      paddingX="sm"
      paddingY="xs"
      background={entry.current ? 'muted' : 'none'}
    >
      <Box shrink={false}>
        <Text size="sm" weight="medium">{`#${entry.number}`}</Text>
      </Box>
      <Box grow shrink minWidth={0}>
        <Text size="sm" truncate>
          {entry.title}
        </Text>
      </Box>
      <Box shrink={false}>
        <Text size="xs" muted>
          {entry.status}
        </Text>
      </Box>
      {/* Every row keeps this slot, so the statuses line up with the current row's. */}
      <Box width={SWITCH_SLOT_WIDTH} shrink={false} direction="row" justify="end">
        {entry.current ? null : busy === entry.number ? (
          <Spinner label={`Switching to #${entry.number}`} labelHidden />
        ) : (
          <Button
            key={`pr-${entry.number}`}
            size="xs"
            variant="outline"
            tooltip={entry.branch ? `Check out ${entry.branch} in this workspace` : 'GitHub did not say which branch this is'}
            disabled={busy !== null || isLoading || !entry.branch}
            onPress={() => switchTo(entry)}
          >
            Switch
          </Button>
        )}
      </Box>
    </Box>
  )
}

function StackList({ shown }: { shown: Extract<StackView, { kind: 'stack' }> }) {
  const { stack } = shown
  return (
    <Stack gap="sm">
      <Row gap="xs" align="center">
        <Text size="sm" weight="semibold">{`Stack #${stack.number}`}</Text>
        <Text size="sm" muted>{`${stack.position ?? '–'} of ${stack.size} · ${stack.base}`}</Text>
      </Row>
      <Box border radius="md" paddingY="xs">
        {stack.entries.map((entry) => (
          <EntryRow entry={entry} />
        ))}
        <Box paddingX="sm" paddingY="xs">
          <Text size="xs" muted>{`↳ ${stack.base}`}</Text>
        </Box>
      </Box>
    </Stack>
  )
}

function Body({ shown }: { shown: StackView }) {
  switch (shown.kind) {
    case 'stack':
      return <StackList shown={shown} />
    case 'no-workspace':
      return (
        <EmptyState title="No workspace open" icon="layers">
          <Text muted>Open a workspace to see the stack its PR is in.</Text>
        </EmptyState>
      )
    case 'no-branch':
      return (
        <EmptyState title="No branch" icon="branch">
          <Text muted>{`${shown.workspace} is not on a branch.`}</Text>
        </EmptyState>
      )
    case 'no-pr':
      return (
        <EmptyState title="No pull request" icon="branch">
          <Text muted>{`${shown.branch} has no pull request on GitHub.`}</Text>
        </EmptyState>
      )
    case 'no-stack':
      return (
        <EmptyState title="Not stacked" icon="layers">
          <Text muted>{`#${shown.pr} isn't part of a stack.`}</Text>
        </EmptyState>
      )
    case 'other-host':
      return (
        <EmptyState title="On another machine" icon="globe">
          <Text muted>{`${shown.workspace} is on another machine. Stack Switcher works with workspaces on this one.`}</Text>
        </EmptyState>
      )
    case 'ambiguous':
      return (
        <EmptyState title="Can't tell which workspace this is" icon="layers">
          <Text muted>
            {`Several workspaces are named "${shown.workspace}" and are on ${shown.branch}. Rename this one in Orca to see its stack.`}
          </Text>
        </EmptyState>
      )
    case 'error':
      return (
        <Callout tone="danger" title="Couldn't load the stack">
          <Stack gap="sm">
            <Text>{shown.message}</Text>
            <Row>
              <Button size="xs" variant="outline" onPress={() => load()}>
                Try again
              </Button>
            </Row>
          </Stack>
        </Callout>
      )
  }
}

export default function Panel() {
  const shown = read(view)
  const message = read(notice)
  const isLoading = read(loading)
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Text size="xs" muted>
          {shown && 'workspace' in shown ? shown.workspace : 'GitHub stack'}
        </Text>
        {isLoading ? (
          <Spinner label="Loading the stack" labelHidden />
        ) : (
          <IconButton icon="refresh" label="Refresh" size="xs" variant="ghost" onPress={() => load()} />
        )}
      </Row>
      {message ? (
        message.tone === 'neutral' ? (
          <Text size="xs" muted>
            {message.text}
          </Text>
        ) : (
          <Callout tone={message.tone} title={message.title}>
            <Text>{message.text}</Text>
          </Callout>
        )
      ) : null}
      {shown ? <Body shown={shown} /> : <Spinner label="Loading the stack" />}
    </Stack>
  )
}
