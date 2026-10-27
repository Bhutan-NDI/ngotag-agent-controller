// Jest-only stand-in for 'koffi' (mapped in jest.config.base.ts). koffi keeps named types per
// process, but Jest re-evaluates @openwallet-foundation/askar-nodejs for every test file a worker
// runs, so the second load fails with "Duplicate type name 'ByteBuffer'". Reuse a named struct or
// callback type that is already registered instead of declaring it again. Production loads
// askar-nodejs once and never goes through this file.
const koffi = require('koffi/index.js')

const reuseNamed =
  (declare) =>
  (name, ...rest) => {
    if (typeof name === 'string') {
      try {
        return koffi.resolve(name)
      } catch {
        // Not registered yet (or not a plain name): declare it below.
      }
    }
    return declare(name, ...rest)
  }

module.exports = { ...koffi, struct: reuseNamed(koffi.struct), proto: reuseNamed(koffi.proto) }
