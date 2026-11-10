import { assert, test } from 'orca/testing'
import { childEnv } from './env'

test('drops the variables that tie git to another repository and keeps the rest', () => {
  const env = childEnv(
    { LC_ALL: 'C' },
    {
      PATH: '/bin',
      HOME: '/home/me',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/.git/index',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/elsewhere/hooks',
      GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work'
    }
  )
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/me', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work', LC_ALL: 'C' })
})
