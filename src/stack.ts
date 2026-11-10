// Turns GitHub's answers into what the panel shows. Pure functions: no git, gh or Orca calls.

export type StackEntry = {
  number: number
  title: string
  url: string
  /** The PR's head branch; null when GitHub did not say. */
  branch: string | null
  /** Short status, as Orca's own stack view words it: "checks pending", "approved", ... */
  status: string
  /** The PR the workspace's branch belongs to. */
  current: boolean
}

export type Stack = {
  number: number
  size: number
  /** Where the current PR sits, counting from the bottom (1); null when it is not listed. */
  position: number | null
  base: string
  /** Top of the stack first. */
  entries: StackEntry[]
}

type Json = Record<string, unknown>

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Json)[key] : undefined
}

/** Same words and precedence as Orca's own stack view (GitHubPRStackMap). */
function entryStatus(pr: unknown): string {
  const state = field(pr, 'state')
  const checks = field(field(pr, 'statusCheckRollup'), 'state')
  const review = field(pr, 'reviewDecision')
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  if (field(pr, 'isDraft') === true) return 'draft'
  if (field(pr, 'mergeable') === 'CONFLICTING') return 'conflicts'
  if (checks === 'FAILURE' || checks === 'ERROR') return 'checks failed'
  if (checks === 'PENDING' || checks === 'EXPECTED') return 'checks pending'
  if (review === 'CHANGES_REQUESTED') return 'changes requested'
  if (review === 'REVIEW_REQUIRED') return 'review needed'
  if (review === 'APPROVED') return 'approved'
  return 'open'
}

function parseEntry(node: unknown, currentNumber: number): (StackEntry & { position: number }) | null {
  const position = field(node, 'position')
  const pr = field(node, 'pullRequest')
  const number = field(pr, 'number')
  const title = field(pr, 'title')
  const url = field(pr, 'url')
  const branch = field(pr, 'headRefName')
  if (
    typeof position !== 'number' ||
    typeof number !== 'number' ||
    typeof title !== 'string' ||
    typeof url !== 'string'
  ) {
    return null
  }
  return {
    position,
    number,
    title,
    url,
    branch: typeof branch === 'string' && branch !== '' ? branch : null,
    status: entryStatus(pr),
    current: number === currentNumber
  }
}

/** `response` is GitHub's answer to the stack query; null when the PR is not in a stack. */
export function parseStack(response: unknown, currentNumber: number): Stack | null {
  const stack = field(field(field(field(response, 'data'), 'repository'), 'pullRequest'), 'stack')
  const number = field(stack, 'number')
  if (typeof number !== 'number') {
    return null
  }
  const nodes = field(field(stack, 'entries'), 'nodes')
  const parsed = (Array.isArray(nodes) ? nodes : [])
    .map((node) => parseEntry(node, currentNumber))
    .filter((entry): entry is StackEntry & { position: number } => entry !== null)
    .sort((a, b) => b.position - a.position)
  const size = field(stack, 'size')
  const base = field(stack, 'baseRefName')
  return {
    number,
    size: typeof size === 'number' ? size : parsed.length,
    position: parsed.find((entry) => entry.current)?.position ?? null,
    base: typeof base === 'string' ? base : '',
    entries: parsed.map(({ position: _position, ...entry }) => entry)
  }
}
