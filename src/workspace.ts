// Which of Orca's workspaces is the one in front of the person.

/** One row of the `workspace.list` host call. */
export type ListedWorkspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

/** What `workspace.readContext` answers. */
export type WorkspaceContext = {
  branch: string
  displayName: string
  terminals: { id: string; title?: string }[]
} | null

/**
 * Orca tells plugins the open workspace's name and branch, not its id or folder, so match those
 * against `workspace.list`: by name, then by branch when names repeat. More than one remain when
 * look-alikes share both, such as several repositories' checkouts that Orca names "main".
 */
export function findWorkspaceCandidates(
  context: WorkspaceContext,
  workspaces: readonly ListedWorkspace[]
): ListedWorkspace[] {
  if (!context) {
    return []
  }
  const named = workspaces.filter((workspace) => workspace.name === context.displayName)
  return named.length > 1 ? named.filter((workspace) => workspace.branch === context.branch) : named
}
