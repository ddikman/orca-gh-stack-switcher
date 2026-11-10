import { assert, test } from 'orca/testing'
import { parseStack } from './stack'
import { stackNode, stackResponse, threePrStack } from './test-fixtures'

type Fields = Omit<Parameters<typeof stackNode>[1], 'number' | 'title' | 'headRefName'>

function statusOf(fields: Fields): string | undefined {
  const response = stackResponse({
    number: 1,
    size: 1,
    baseRefName: 'main',
    nodes: [stackNode(1, { number: 2, title: 'A change', headRefName: 'a-change', ...fields })]
  })
  return parseStack(response, 2)?.entries[0]?.status
}

// Same words and the same order of precedence as Orca's own stack view.
const statusCases: [string, Fields, string][] = [
  ['merged wins over everything', { state: 'MERGED', isDraft: true, mergeable: 'CONFLICTING' }, 'merged'],
  ['closed wins over draft', { state: 'CLOSED', isDraft: true }, 'closed'],
  ['draft wins over conflicts', { isDraft: true, mergeable: 'CONFLICTING' }, 'draft'],
  ['conflicts win over failing checks', { mergeable: 'CONFLICTING', checks: 'FAILURE' }, 'conflicts'],
  ['failing checks', { checks: 'FAILURE', reviewDecision: 'APPROVED' }, 'checks failed'],
  ['an errored check counts as failing', { checks: 'ERROR' }, 'checks failed'],
  ['running checks win over an approval', { checks: 'PENDING', reviewDecision: 'APPROVED' }, 'checks pending'],
  ['expected checks count as pending', { checks: 'EXPECTED' }, 'checks pending'],
  ['changes requested', { reviewDecision: 'CHANGES_REQUESTED' }, 'changes requested'],
  ['review needed', { reviewDecision: 'REVIEW_REQUIRED' }, 'review needed'],
  ['approved', { reviewDecision: 'APPROVED' }, 'approved'],
  ['open when no review is required', { reviewDecision: null, checks: null }, 'open']
]

test('answers null when the PR is not part of a stack', () => {
  assert.equal(parseStack(stackResponse(null), 12), null)
})

test('leaves out stack rows GitHub returns without a PR', () => {
  const response = stackResponse({
    number: 10,
    size: 3,
    baseRefName: 'main',
    nodes: [
      stackNode(1, { number: 11, title: 'Add the model', headRefName: 'feat/model' }),
      { position: 2, pullRequest: null },
      null
    ]
  })
  assert.deepEqual(
    parseStack(response, 11)?.entries.map((entry) => entry.number),
    [11]
  )
})

for (const [name, fields, expected] of statusCases) {
  test(`status: ${name}`, () => {
    assert.equal(statusOf(fields), expected)
  })
}

test('lists the stack top-first and marks the PR the workspace is on', () => {
  const stack = parseStack(threePrStack(), 12)

  assert.deepEqual(stack, {
    number: 10,
    size: 3,
    position: 2,
    base: 'main',
    entries: [
      {
        number: 13,
        title: 'Wire it up',
        url: 'https://github.com/acme/widgets/pull/13',
        branch: 'feat/wiring',
        status: 'review needed',
        current: false
      },
      {
        number: 12,
        title: 'Add the screen',
        url: 'https://github.com/acme/widgets/pull/12',
        branch: 'feat/screen',
        status: 'review needed',
        current: true
      },
      {
        number: 11,
        title: 'Add the model',
        url: 'https://github.com/acme/widgets/pull/11',
        branch: 'feat/model',
        status: 'review needed',
        current: false
      }
    ]
  })
})
