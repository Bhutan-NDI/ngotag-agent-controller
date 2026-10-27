# Askar native memory

Controllers on `@openwallet-foundation/askar-nodejs` 0.4.3 kept growing in memory
under DIDComm traffic, roughly 25 KB per inbound message per process, and only a
restart released it. The growth was outside the JavaScript heap: heap snapshots
returned to their baseline after each batch while the process size kept rising.

## Cause

Askar 0.4.3 calls the native library through `@2060.io/ffi-napi` 4.0.9. That layer
keeps native memory on every call, and every DIDComm message makes several Askar
calls (session open/close, record fetches, pack/unpack). Capping glibc arenas
(`MALLOC_ARENA_MAX=2`) and calling `malloc_trim` did not change the growth, so it
is not allocator retention. A plain libc call made through `ffi-napi` grew too.

Memory kept per operation in a local micro-benchmark (Node 22.22.2, Postgres 16):

| Operation                   | 0.4.3 (`ffi-napi`) | 0.6.1 (`koffi`) |
| --------------------------- | -----------------: | --------------: |
| libc `abs`, no Askar        |              565 B |             7 B |
| Session open + close        |             3.7 KB |              ≈0 |
| Record fetch                |             4.7 KB |           140 B |
| Pack + unpack (`CryptoBox`) |            11.8 KB |           114 B |

Two local controllers per build (`develop` before, this change after), 13,000
question messages from B to A at 20 per second, A's process size after each
batch had settled:

| A's RSS                      | before (0.4.3) | after (0.6.1) |
| ---------------------------- | -------------: | ------------: |
| After 1,000 warm-up messages |         331 MB |        263 MB |
| After 6,000 more             |         479 MB |        269 MB |
| After another 6,000          |         548 MB |        280 MB |
| Growth per message           |       ≈18.5 KB |       ≈1.5 KB |

All messages were delivered on both builds. The small growth that remains after
the change was not investigated further.

## Change

`askar-nodejs` and `askar-shared` 0.6.1 use `koffi` and bundle native Askar 0.5.0.
`@credo-ts/askar` 0.6.2 declares a peer range of `^0.4.3`, but every export it
uses exists in 0.6.1, and Credo 0.7 accepts 0.6 officially.

- The scan result-list patch moves to `askar-shared` 0.6.1 unchanged; 0.6.1 still
  does not release those lists ([details](single-record-query-bound.md)).
- `askar.version()` returns a raw pointer in 0.6.1, so the DID write route no
  longer logs it.
- `koffi` registers named types once per process. Jest re-loads modules for each
  test file in a worker, so `jest.koffi.cjs` reuses already-registered types in
  tests only.
- AnonCreds and Indy VDR still use `ffi-napi`; its patch and rebuild stay
  ([details](native-callback-lifecycle.md)). They are called far less often than
  Askar.

## Wallet compatibility

Native Askar 0.5.0 keeps the 0.4.6 storage format. Locally, on SQLite and
Postgres: 0.4.3 created a wallet with a second profile, records, tags and keys;
0.6.1 opened it, read and verified everything (including a signature with a
stored key), wrote new records, keys and a profile; 0.4.3 then opened it again
and read both sets. The Postgres `config.version` stayed `1` and no table
changed, so rolling back to the previous image keeps working wallets.
