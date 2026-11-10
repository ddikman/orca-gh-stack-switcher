// Test data only. Shaped like GitHub's real answer to the stack query in src/github.ts
// (`repository.pullRequest.stack`), with made-up PRs.

type PrFields = {
  number: number
  title: string
  headRefName: string
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft?: boolean
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeStateStatus?: string
  checks?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null
}

export function stackNode(position: number, pr: PrFields) {
  return {
    position,
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: `https://github.com/acme/widgets/pull/${pr.number}`,
      updatedAt: '2026-11-09T10:00:00Z',
      state: pr.state ?? 'OPEN',
      isDraft: pr.isDraft ?? false,
      headRefName: pr.headRefName,
      headRefOid: `${pr.number}`.padEnd(40, '0'),
      mergeable: pr.mergeable ?? 'MERGEABLE',
      reviewDecision: pr.reviewDecision === undefined ? 'REVIEW_REQUIRED' : pr.reviewDecision,
      mergeStateStatus: pr.mergeStateStatus ?? 'BLOCKED',
      statusCheckRollup: pr.checks === null ? null : { state: pr.checks ?? 'SUCCESS' }
    }
  }
}

export function stackResponse(
  stack: { number: number; size: number; baseRefName: string; nodes: unknown[] } | null
) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 0,
          stack:
            stack === null
              ? null
              : {
                  number: stack.number,
                  size: stack.size,
                  baseRefName: stack.baseRefName,
                  entries: { nodes: stack.nodes }
                }
        }
      }
    }
  }
}

/** A three-PR stack on `main`: #11 at the bottom, #13 on top. */
export function threePrStack() {
  return stackResponse({
    number: 10,
    size: 3,
    baseRefName: 'main',
    nodes: [
      stackNode(1, { number: 11, title: 'Add the model', headRefName: 'feat/model' }),
      stackNode(2, { number: 12, title: 'Add the screen', headRefName: 'feat/screen' }),
      stackNode(3, { number: 13, title: 'Wire it up', headRefName: 'feat/wiring' })
    ]
  })
}
