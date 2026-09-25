import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'

describe('bounded proof format queries with native Askar', () => {
  it('preserves fresh format data, duplicate errors and tenant isolation', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.resolve('src/storage/fixtures/proofFormat.native.mjs')],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    )
    expect(stdout).toMatch(/tests 19\b/)
    expect(stdout).toMatch(/pass 19\b/)
    expect(stdout).toMatch(/fail 0\b/)
  })
})
