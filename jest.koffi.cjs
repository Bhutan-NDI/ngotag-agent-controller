// Reuses already-registered koffi types so Jest can re-load askar-nodejs per test file.
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
