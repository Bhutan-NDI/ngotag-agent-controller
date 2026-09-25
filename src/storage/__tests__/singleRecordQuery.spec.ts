import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'

// Native ESM Credo/Askar modules run outside Jest's VM module loader, while the
// wrapper keeps these integration checks in the normal `yarn test` CI suite.
describe('Credo single-record query with native Askar storage', () => {
  it('preserves lookup semantics and bounds duplicate materialization', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.resolve('src/storage/fixtures/singleRecordQuery.native.mjs')],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    )
    // Also require the native suite summary: a clean child exit alone must not
    // let an early exit or an empty test run silently bypass these regressions.
    expect(stdout).toMatch(/tests 17\b/)
    expect(stdout).toMatch(/pass 17\b/)
    expect(stdout).toMatch(/fail 0\b/)
  })
})
