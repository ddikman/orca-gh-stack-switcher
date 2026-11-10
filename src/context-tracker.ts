// When the panel needs to load the stack again, from Orca's workspace.changed events. Orca sends
// one when focus moves, but also whenever a terminal opens, closes or is renamed (agents rename
// theirs all the time), and it replays the current context to each new listener.

import type { WorkspaceContext } from './workspace'

/** A workspace and branch the panel showed. */
type Shown = { displayName: string; branch: string }

const keyOf = (context: Shown) => `${context.displayName}\n${context.branch}`

export function createContextTracker() {
  /** The last context a load accounted for; undefined before the first event. */
  let lastKey: string | undefined
  let firstLoadIsDone = false
  /** A branch the panel switched to, whose context Orca has not reported yet. */
  let pendingBranch: string | null = null

  return {
    /** A load finished, showing `shown`'s workspace and branch (null: none). Until an event says
     *  otherwise, that is the context the panel accounts for. */
    loaded(shown: Shown | null): void {
      firstLoadIsDone = true
      if (lastKey === undefined && shown) {
        lastKey = keyOf(shown)
      }
    },

    /** The panel switched this workspace to `branch`, and loads its stack itself. */
    switchedTo(branch: string): void {
      pendingBranch = branch
    },

    /** Whether this context needs the stack loaded again. */
    needsLoad(context: WorkspaceContext): boolean {
      const key = context ? keyOf(context) : ''
      if (key === lastKey) {
        return false // Only the terminals changed.
      }
      const isFirst = lastKey === undefined
      lastKey = key
      if (isFirst && !firstLoadIsDone) {
        return false // Orca replaying the context the panel opened on; the first load covers it.
      }
      if (context && pendingBranch !== null && context.branch === pendingBranch) {
        // Orca catching up with the panel's own switch. Only the branch is compared: Orca may also
        // rename a workspace it had named after its old branch.
        pendingBranch = null
        return false
      }
      return true
    }
  }
}
