// @2060.io/ffi-napi hangs jest workers in CI; no spec needs it, so fail loudly if one ever calls into it.
const stub = () =>
  new Proxy(function () {}, {
    get: (_target, prop) => (prop === '__esModule' ? false : stub()),
    apply: () => {
      throw new Error('@2060.io/ffi-napi is stubbed in jest (see jest.ffistub.cjs)')
    },
    construct: () => {
      throw new Error('@2060.io/ffi-napi is stubbed in jest (see jest.ffistub.cjs)')
    },
  })

module.exports = stub()
