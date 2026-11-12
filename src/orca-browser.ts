// Opens a stack's PR in a browser tab of Orca. Orca lets plugins open a URL only in the person's web
// browser (`shell.openExternal`), so this runs the orca command that comes with Orca, as an agent in
// the workspace would: `orca tab create --url <url> --worktree path:<folder>`. Worker-only (Node).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { childEnv } from './env'
import type { OpenOutcome, OpenTarget } from './protocol'
import { isLocal, type ListedWorkspace } from './workspace'

/** The orca command failed; the message is what it said. */
export class OrcaCliError extends Error {}

/** Runs the orca command with `args`; resolves with what it printed, rejects with an OrcaCliError. */
export type RunOrca = (args: string[]) => Promise<string>

/**
 * The orca command of the Orca that runs this worker. Orca starts workers with its own executable,
 * which knows where Orca's files are (`resourcesPath`), and without the shell's PATH: on macOS the
 * command is `Orca.app/Contents/Resources/bin/orca`. Anywhere else, the `orca` on PATH.
 */
export function orcaCommand(resourcesPath: string | undefined): string {
  const bundled = resourcesPath === undefined ? null : join(resourcesPath, 'bin', 'orca')
  return bundled !== null && existsSync(bundled) ? bundled : 'orca'
}

/** What orca's --json answer says it could not do: its first next step, else its message. */
function failureIn(stdout: string): string | null {
  let error: { message?: unknown; data?: { nextSteps?: unknown } | null } | null | undefined
  try {
    error = (JSON.parse(stdout) as { error?: typeof error } | null)?.error
  } catch {
    return null
  }
  const steps = error?.data?.nextSteps
  if (Array.isArray(steps) && typeof steps[0] === 'string') return steps[0]
  return typeof error?.message === 'string' ? error.message : null
}

/** Runs `command`, an orca CLI, with `args` and --json. */
export function runOrcaCli(command: string): RunOrca {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...args, '--json'],
        { env: childEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout)
            return
          }
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new OrcaCliError("Couldn't find the orca command that comes with Orca."))
            return
          }
          reject(new OrcaCliError(failureIn(stdout) ?? (stderr.trim() || stdout.trim() || error.message)))
        }
      )
    })
}

/** The orca command of the Orca running this worker (Electron sets `resourcesPath` for it). */
export const execOrca: RunOrca = (args) =>
  runOrcaCli(orcaCommand((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath))(args)

/** Opens `target.url` in a new browser tab of Orca, in the workspace `target.workspaceId`. */
export async function openInOrca(
  listWorkspaces: () => Promise<ListedWorkspace[]>,
  runOrca: RunOrca,
  target: OpenTarget
): Promise<OpenOutcome> {
  try {
    // A tab opens whatever it is given, so give it only a web address.
    if (!/^https?:\/\//i.test(target.url)) {
      return { kind: 'failed', message: `${target.url} isn't a web address.` }
    }
    const workspace = (await listWorkspaces()).find((listed) => listed.id === target.workspaceId)
    if (!workspace || !isLocal(workspace)) {
      return { kind: 'failed', message: "Can't find this stack's workspace on this machine any more." }
    }
    await runOrca(['tab', 'create', '--url', target.url, '--worktree', `path:${workspace.path}`])
    return { kind: 'opened' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
