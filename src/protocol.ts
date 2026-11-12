// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Stack } from './stack'

/** What the panel shows for the workspace in front of the person. */
export type StackView =
  | { kind: 'no-workspace' }
  /** A detached HEAD: no branch, so no PR. */
  | { kind: 'no-branch'; workspace: string }
  | { kind: 'no-pr'; workspace: string; branch: string }
  | { kind: 'no-stack'; workspace: string; branch: string; pr: number }
  /** `workspaceId` names the workspace this stack is for; a switch must be for that same one. */
  | { kind: 'stack'; workspace: string; workspaceId: string; branch: string; pr: number; stack: Stack }
  /** The open workspace lives on another machine (an SSH host), out of this plugin's reach. */
  | { kind: 'other-host'; workspace: string }
  /** Several workspaces share this name and branch, and they would not all show the same thing. */
  | { kind: 'ambiguous'; workspace: string; branch: string }
  | { kind: 'error'; message: string }

/** Which PR to switch to, from a row the panel showed for the workspace `workspaceId`. */
export type SwitchTarget = { number: number; branch: string; url: string; workspaceId: string }

export type SwitchOutcome =
  /** This workspace now has the branch checked out; `note` is anything worth knowing about it. */
  | { kind: 'switched'; branch: string; note?: string }
  /** Another Orca workspace already had the branch, so Orca now shows that one. */
  | { kind: 'opened'; workspace: string; branch: string }
  /** Nothing changed, on purpose; `reason` says why. */
  | { kind: 'refused'; reason: string }
  /** Git, gh or Orca failed part-way; `message` is what they said. */
  | { kind: 'failed'; message: string }

/** Which PR to open in Orca's browser, from a row the panel showed for the workspace `workspaceId`. */
export type OpenTarget = { url: string; workspaceId: string }

export type OpenOutcome =
  /** Orca opened the PR in a new browser tab of that workspace. */
  | { kind: 'opened' }
  /** Nothing opened; `message` says why. */
  | { kind: 'failed'; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The stack of the focused workspace's PR. */
    'stack.load': { output: StackView }
    /** Switches the focused workspace to another PR of its stack. */
    'stack.switch': { input: SwitchTarget; output: SwitchOutcome }
    /** Opens a PR of the stack in a browser tab of Orca, in the workspace the panel showed it for. */
    'stack.openInOrca': { input: OpenTarget; output: OpenOutcome }
  }
}
