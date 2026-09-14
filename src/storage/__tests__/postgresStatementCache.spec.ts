import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'

describe('PostgreSQL statement-cache configuration', () => {
  it('preserves defaults and validates the native URI boundary', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.resolve('src/storage/fixtures/postgresStatementCache.native.mjs')],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    )
    expect(stdout).toMatch(/tests 6\b/)
    expect(stdout).toMatch(/pass 6\b/)
    expect(stdout).toMatch(/fail 0\b/)
  })
})
