import type { Config } from '@jest/types'

// The runtime dependency graph (@credo-ts/*, @ayanworks/*) ships as native ESM (.mjs). Run Jest in
// ESM mode so those modules load natively instead of being (mis)parsed as CommonJS. Requires
// NODE_OPTIONS=--experimental-vm-modules (wired into the "test" script).
const config: Config.InitialOptions = {
  testTimeout: 120000,
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // Type-aware emit (isolatedModules off) so type-only named imports that aren't written as
        // `import type` are elided — otherwise ESM linking fails on them across the source graph.
        isolatedModules: false,
        // Don't fail tests on type diagnostics here. Source is type-checked by `yarn check-types`
        // (tsconfig.build.json) and the test files by `yarn check-types:test` (tsconfig.test.json,
        // which includes **/__tests__/*.ts); both run in `yarn validate`.
        diagnostics: false,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  // Source uses ESM-style '.js' specifiers for its own '.ts' files, which Jest cannot resolve on its
  // own. Map them back to extensionless so a spec can import a module that uses them.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  coveragePathIgnorePatterns: ['/build/', '/node_modules/', '/__tests__/', 'tests'],
  coverageDirectory: '<rootDir>/coverage/',
  verbose: true,
  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],
}

export default config
