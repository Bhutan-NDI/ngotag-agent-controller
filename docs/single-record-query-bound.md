# Wallet query bounds and native result cleanup

Two version-pinned dependency patches improve the existing wallet query path.
They do not change API responses, query predicates, tenant/profile selection,
indexes, schemas, caches, issuance concurrency, or session configuration.

## Single-record query bound

Credo's `Repository.findSingleByQuery` distinguishes no record, one record, and a
duplicate-record error. Previously it materialized every match before making
that decision. The core patch passes `{ limit: 2 }` through the existing storage
query. Two matches are sufficient; a limit of one would silently hide duplicates.
General list queries and their pagination are unchanged.

A unique lookup still needs its result, and a missing lookup still needs to
establish absence. A result limit does not guarantee fewer examined rows or lower
CPU/latency for those cases. Storage adapters that ignore the limit remain correct
but gain no performance benefit. This is not a database-sizing recommendation.

## Release native scan result lists

Each successful native `scanNext` returns an independently owned result-list
handle. The JavaScript wrapper copied its records but did not release that handle.
`scanFree` releases the scan; it does not release those returned result lists.

The Askar shared-wrapper patch frees each list in a `finally` block immediately
after copying its entries. It also frees the current list if counting or copying
an entry throws. The outer scan cleanup remains intact. `Entry.toJson` produces
owned strings and parsed tag objects, so the returned records remain usable after
freeing the native list. This follows the ownership pattern already used by
Askar's `Session.fetchAll`.

This fixes native result retention during wallet queries. It does not itself
change PostgreSQL query plans or establish a database CPU reduction.

Upstream ownership references:

- [JavaScript Scan v0.4.3](https://github.com/openwallet-foundation/askar-wrapper-javascript/blob/v0.4.3/packages/askar-shared/src/store/Scan.ts)
- [Native scan creation/free v0.4.6](https://github.com/openwallet-foundation/askar/blob/v0.4.6/src/ffi/store.rs)

## Regression verification

Run `yarn test --runInBand src/storage/__tests__/singleRecordQuery.spec.ts`.
The wrapper launches 17 native integration cases outside Jest's VM module loader,
using the installed, patched Credo repository and Askar adapter with disposable
SQLite wallets. It verifies:

- Missing/unique records and complete serialization.
- Duplicate detection and bounded materialization, including DIDComm save/update.
- Profile/category isolation, role filters and compound predicates.
- Unchanged general lists and explicit pagination.
- Existing opt-in cache behavior and storage-error propagation.
- Exact native result-list release across multiple batches, early limit exit,
  empty scans, and record-conversion failures.

No configured application database, agent, environment file, or cloud service is
accessed by these tests. When upgrading dependencies, re-evaluate both patches
and keep these regression tests until equivalent upstream behavior is verified.

## Local PostgreSQL benchmark

The manual benchmark uses a dedicated local Docker container, 11,000 synthetic
records, five tags per record and roughly 1 KiB of content per record. There are
10,000 unique exchange IDs and one deliberately duplicated ID matching 1,000
records. No application data or database URL is accepted.

With a **local** Docker context, create the disposable fixture:

```sh
docker run --rm -d --name codex-credo-priority1-pg16 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 \
  postgres:16 \
  -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on

docker exec codex-credo-priority1-pg16 pg_isready -U postgres
# Wait for the readiness check to succeed before seeding.
node scripts/benchmark-single-record-query.mjs seed
```

Run each scenario (`unique`, `missing`, `duplicate`) in both modes, alternating
order between repeats:

```sh
node scripts/benchmark-single-record-query.mjs before unique 200 20
node scripts/benchmark-single-record-query.mjs after unique 200 20
```

The last two arguments are measured operations and warm-up operations. Defaults
are 200 and 20; use `2000 1000` for a longer normal-lookup run. The baseline mode
omits the query limit and deliberately bypasses native result-list freeing to
reproduce the original scan behavior. This deliberate leak exists only in the
benchmark process, never in application configuration.

The benchmark resets `pg_stat_statements` only inside its dedicated fixture,
then reports p50/p95/p99 latency, sequential throughput, application CPU time,
process peak RSS, returned rows, native handle counts and PostgreSQL execution/
buffer metrics. Database execution time is not a direct CPU measurement. Peak
RSS includes module loading and warm-up. A warm-cache, single-client fixture is
not a production capacity test.

A watchdog rejects hung runs. Successful output is emitted only after the native
store closes; a timeout, native abort, or nonzero exit must not be counted as a
completed benchmark. Keep failures visible when assessing stability and latency.

Remove only this disposable fixture after testing:

```sh
docker stop codex-credo-priority1-pg16
```

See [measurement results and limitations](single-record-query-measurements.md)
for the observed results. Production sizing requires separate representative
query-plan, throughput, tail-latency and peak-load validation.
