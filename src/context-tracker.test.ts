import { assert, test } from 'orca/testing'
import { createContextTracker } from './context-tracker'

const at = (displayName: string, branch: string) => ({ displayName, branch, terminals: [] })

test('reloads when the workspace or its branch changes', () => {
  const tracker = createContextTracker()
  tracker.loaded(null)
  assert.equal(tracker.needsLoad(at('widgets', 'feat/screen')), true)
  assert.equal(tracker.needsLoad(at('gadgets', 'feat/screen')), true)
  assert.equal(tracker.needsLoad(at('gadgets', 'main')), true)
  assert.equal(tracker.needsLoad(null), true)
})

test('does not reload when only terminals opened, closed or were renamed', () => {
  const tracker = createContextTracker()
  tracker.loaded(null)
  assert.equal(tracker.needsLoad(at('widgets', 'main')), true)
  assert.equal(tracker.needsLoad({ ...at('widgets', 'main'), terminals: [{ id: 't2', title: 'claude' }] }), false)
  assert.equal(tracker.needsLoad(at('widgets', 'main')), false)
})

test('does not reload for the workspace the last load already showed', () => {
  const tracker = createContextTracker()
  tracker.loaded({ displayName: 'widgets', branch: 'main' })
  assert.equal(tracker.needsLoad(at('widgets', 'main')), false)
  assert.equal(tracker.needsLoad(at('widgets', 'feat/screen')), true)
})

test('does not reload for the context Orca replays while the first load runs', () => {
  const tracker = createContextTracker()
  assert.equal(tracker.needsLoad(at('widgets', 'main')), false)
  tracker.loaded(null)
  assert.equal(tracker.needsLoad(at('widgets', 'main')), false)
  assert.equal(tracker.needsLoad(at('widgets', 'feat/screen')), true)
})

test('does not reload when Orca catches up with a switch the panel made', () => {
  const tracker = createContextTracker()
  tracker.loaded({ displayName: 'feat/screen', branch: 'feat/screen' })
  tracker.switchedTo('feat/wiring')
  // Orca may rename a workspace it named after its branch, so only the branch is matched.
  assert.equal(tracker.needsLoad(at('feat/wiring', 'feat/wiring')), false)
  assert.equal(tracker.needsLoad(at('feat/wiring', 'feat/model')), true)
})
