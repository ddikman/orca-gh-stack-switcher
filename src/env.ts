// The environment git and gh run with. Worker-only (Node).

/**
 * What git itself clears before working in another repository (`git rev-parse --local-env-vars`).
 * A git hook, `git rebase -x` or `git bisect run` exports these for *its* repository, and they would
 * point every command here at that one instead of the workspace's.
 */
const REPOSITORY_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR'
])

function isRepositoryVariable(key: string): boolean {
  // GIT_CONFIG_COUNT's numbered pairs go with it.
  return REPOSITORY_VARIABLES.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
}

/** The worker's environment, read at each call, without repository variables, plus `extra`. */
export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isRepositoryVariable(key)) env[key] = value
  }
  return { ...env, ...extra }
}
