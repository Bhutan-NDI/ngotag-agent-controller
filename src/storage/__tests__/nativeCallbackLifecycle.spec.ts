import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'

// The parent's timeout catches hangs after a child has already printed success.
// execFile also rejects premature exits, native aborts and signals.
describe('native callback lifecycle', () => {
  it.each([1, 2, 3])(
    'completes callbacks and exits naturally (run %s)',
    async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--expose-gc', path.resolve('src/storage/fixtures/nativeCallbackLifecycle.mjs')],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      )
      expect(JSON.parse(stdout)).toEqual({ queries: 4020, closed: true })
    },
    35000,
  )
})
