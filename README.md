# Stack Switcher

An [Orca](https://www.onorca.dev/) plugin that adds a **Stack** panel to the right sidebar. It lists
the GitHub stack that the open workspace's pull request belongs to, the same PRs Orca's own stack
view shows, and gives every PR except the current one a **Switch** button.

Switch checks out that PR's branch in the workspace, the same as running `git switch <branch>`
there yourself. The editor, terminals and Orca's own PR view then follow the new branch.

- If the branch isn't on this machine yet, the plugin fetches it from the remote that points at
  the PR's repository, and the new branch tracks it. This works in shallow, single-branch and
  partial clones too.
- If the branch is already here and GitHub's copy has only moved forward (pushed from another
  machine), it is brought up to date first. If the two differ (a restack or force-push there, or
  commits of its own here), the local copy is kept and the panel says so.
- If another Orca workspace already has the branch, Switch opens that workspace instead, because
  git won't check out one branch in two places.
- It refuses, and says why, if the workspace has uncommitted changes, an agent in it is working,
  or the switch would overwrite a file git ignores here (such as a `.env`). It never stashes
  changes, interrupts an agent or stops a checkout part-way through.
- Workspaces on another machine (SSH) are shown as such and never switched.

Each PR's number opens the PR in your web browser. To open PRs in a browser tab of Orca instead, set
**Open pull requests in** to **Orca's browser** in Orca's Settings, under Stack Switcher. Plugins
can't see Orca's own setting for links, so pick the same one there. Orca gives plugins no way to
open its browser, so for that the plugin runs the `orca` command that comes with Orca
(`orca tab create`): the one inside Orca.app on macOS, elsewhere the `orca` on PATH.

The stack comes from GitHub's stacked pull requests, asked through the `gh` CLI with the same
query Orca's own stack view sends, in the repository the branch is pushed to. `gh` must be
installed and signed in (`gh auth login`).

Orca starts plugins without your shell's environment, so an ssh-agent, a `GH_TOKEN` or proxy
settings that exist only there don't reach this plugin. When a fetch or `gh` fails for that
reason, the panel says what to run in a terminal instead.

## Install

From this folder:

```sh
orca plugin dev load .
```

Orca asks once for consent to what the plugin needs:

| Access | Why |
| --- | --- |
| Runs its own code (a Node process) | to run `git` and `gh` in the workspace's folder, and Orca's `orca` command to open a PR in Orca's browser |
| `workspace:read` | to know which workspace is open and where its folder is |
| `workspace:write` | to open the workspace that already has a branch checked out |
| `agent:read` | to refuse switching while an agent in the workspace is working |
| `settings:own` | to read where you chose to open PRs |

Then open the panel from the **Stack** icon in the right sidebar, or with
`orca plugin open local.gh-stack-switcher --panel stack`.

## How it is built

| File | What it does |
| --- | --- |
| `src/panel.tsx` | The panel: the stack list, the PR links, the Switch buttons and what each outcome says. |
| `src/worker.ts` | The plugin's worker: answers the panel's `stack.load`, `stack.switch` and `stack.openInOrca`. |
| `src/switcher.ts` | Finds the open workspace, loads its stack, and decides whether and how to switch. |
| `src/git.ts` | The git commands it runs (branch, status, worktrees, remotes, fetch and switch). |
| `src/github.ts` | The `gh` calls: the PR for a branch, and its stack. |
| `src/orca-browser.ts` | Opens a PR in a browser tab of Orca, through the `orca` command. |
| `src/env.ts` | The environment git and gh run with, without variables a git hook may have set. |
| `src/stack.ts` | Turns GitHub's answer into rows, with statuses worded as Orca words them. |
| `src/workspace.ts` | Matches Orca's open workspace (name and branch) to its folder. |
| `src/context-tracker.ts` | Decides which of Orca's workspace events need the stack loaded again. |
| `src/protocol.ts` | The panel ↔ worker contract. |

Orca loads the TypeScript as written; there is no build step.

## Develop

```sh
npm install           # TypeScript and Node typings, for type-checking only
npm test              # orca plugin test .: every *.test.ts(x), in Node
npm run typecheck     # tsc -p .
npm run check         # orca plugin check .: renders each scenario in src/panel.check.ts
orca plugin dev watch .   # loads this folder into Orca and streams its logs and reloads
```

The git tests run real `git` against throwaway repositories in the OS temp folder. The `gh` calls
are stood in for with answers shaped like GitHub's, so the tests never reach GitHub, and the `orca`
command with small scripts, so they never open a tab in Orca.
