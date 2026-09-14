# Priority 3: bounded, fresh proof-format message reads

Credo 0.6.2's proof-v2 `getFormatData` performs three separate message searches:
proposal, request and presentation. The controller calls it for completed-proof
webhook enrichment and for the explicit proof-format endpoint. Repeated calls repeat
those searches.

The platform currently extracts selected fields from webhook `proofData`; it does
not persist the complete format response needed by its detail API. Reusing that
payload would introduce a storage, authorization and retention contract. This PR
instead consolidates the message searches without storing or caching proof data.

## Implementation and compatibility

The existing version-pinned didcomm patch is extended at `DidCommProofV2Protocol.getFormatData`.
For the stock protocol/repository it:

1. Resolves the same message repository using the caller's agent context.
2. Searches by proof association, protocol name and major version, limited to 16 records.
3. For a complete set of fewer than 16 records, applies the original proposal/request/
   presentation predicates and duplicate checks, then uses the original message
   deserialization and attachment-format extraction.
4. If 16 or more records are returned, falls back to the original three exact lookups.
   A bounded prefix is never treated as a complete result.

Custom protocol message-lookup overrides and custom repository `findAgentMessage`
overrides use the existing path. The optimization is specifically for stock proof-v2
format retrieval; other protocol operations are unchanged.

Missing messages still produce the same omitted fields, unknown formats retain their
existing behavior, and duplicate message kinds still raise `RecordDuplicateError`
with the corresponding query. Both sender and receiver roles remain eligible.
There is no cache, expiry, invalidation mechanism or cross-replica shared state.
Updates/deletions are visible on the next read. Each replica reads through its own
current tenant context.

The public API still retrieves the proof exchange record first and uses the same
protocol selection and tenant/authorization path. This change does not alter routes,
response contracts, wallet layout, database schema, encryption, indexes, webhook
retention or the platform. It does not suppress repeated calls: it reduces message
searches within each eligible call from three to one. Overflow cases use four
searches (the prefetch plus the original three). Existing exact-lookup behavior on
overflow is preserved; this PR does not globally bound those existing lookups.

## Correctness tests

Twelve native Askar/SQLite cases exercise the actual patched protocol/repository:

- All eight subsets of present/missing messages, compared with the original lookup path.
- Duplicate kinds, including differing sender/receiver roles, and matching error details.
- Overflow and the exact 15/16-record boundary, with no silent truncation.
- Concurrent same-ID reads in separate profiles.
- Updates, deletion, unrelated IDs/protocols/versions/kinds, malformed attachments,
  unsupported formats, custom overrides and storage failures.

The standalone run passes 35 suites / 354 tests on Node 22.22.2, including this
12-case native fixture. Lint (warnings only), source/test type checks and formatting
also pass.

The suite wrapper checks the native test count and successful completion, so an
empty or premature child-process exit cannot count as a passing regression run.
The final patch also applies cleanly to the published `@credo-ts/didcomm@0.6.2`
package, and its applied protocol file matches the tested file byte-for-byte.

## PostgreSQL measurements

[Raw results](benchmarks/proof-format.json) retain all six trials. The fixture uses
PostgreSQL 16.13, Node 22.22.2, 5,000 synthetic proofs / 15,000 encrypted message
records, three trials per mode, 600 reads per trial, eight concurrent callers and
25% missing proofs. Tables are explicitly analyzed after seeding. Trial order
alternates. Both paths return identical data in all 3,600 measured reads.

The original three stock lookups are exercised through the compatibility path;
the candidate uses the new query. Both modes share the same database, settings and
native binary. The public API's separate proof-record read, HTTP, webhook delivery,
writes and production network/storage behavior are not part of this benchmark.

Medians across three trials, per 600 reads:

| Metric                               |    Original |  Candidate |
| ------------------------------------ | ----------: | ---------: |
| Message searches                     |       1,800 |        600 |
| Returned rows                        |       1,350 |      1,350 |
| p50 latency                          |    10.75 ms |    6.17 ms |
| p95 latency                          |    18.21 ms |   14.14 ms |
| p99 latency                          |    31.44 ms |   20.82 ms |
| Throughput                           |    691.48/s | 1,114.55/s |
| Client CPU time                      | 1,506.25 ms |  853.09 ms |
| PostgreSQL execution time            |    90.80 ms |   42.04 ms |
| PostgreSQL planning + execution time |    94.47 ms |   47.47 ms |
| PostgreSQL shared-buffer hits        |      45,698 |     19,393 |

Database values come from `pg_stat_statements` for the actual native item SELECTs,
not a modeled query counter alone. Planning + execution is calculated per trial
before taking its median; medians of separate columns need not add up. These are
statement timing measurements, not a measurement of total database CPU utilization.
All measured physical buffer reads were zero: this was a warm-buffer experiment.

**Tail latency is not uniformly improved.** The third candidate trial had p99
872.58 ms versus the corresponding baseline's 133.64 ms, and lower throughput. Those
outliers remain in the raw data. The measurements support reduced searches and
statement/buffer work in this synthetic workload, with better median latency; they
do not establish a universal latency improvement, a production RDS resize or dollar
savings. Larger associations can take the fallback and do more searches.

An initial OR-of-message-types query was rejected because measured PostgreSQL work
and latency increased despite fewer searches. An association-only query also incurred
more planning work. The final common protocol predicates avoid those measured
regressions on this fixture. No PostgreSQL plan-cache setting was changed.

## Native runtime and reproduction

The long PostgreSQL benchmark initially stalled during native cleanup with develop's
runtime. The recorded comparison uses the Priority 1 FFI loop-reference fix from
PR #89 for **both** modes; the binary SHA-256 is in the raw results. That runtime fix
is not included in this PR. Short native regression tests and the full repository
suite are separately validated with develop's native runtime. Treat the Priority 1
runtime correction as a prerequisite for reproducing this long benchmark reliably.

In an isolated checkout, install the existing locked dependencies and apply the
existing postinstall patches. Run:

```sh
yarn test --runInBand
yarn lint
yarn check-types
yarn check-types:test
```

For the PostgreSQL benchmark, use a disposable local Docker container only, and a
local benchmark installation incorporating the reviewed Priority 1 FFI fix:

```sh
docker run --rm -d --name codex-priority3-postgres \
  -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD=fixture \
  -p 127.0.0.1::5432 postgres:16.13 \
  -c shared_preload_libraries=pg_stat_statements \
  -c pg_stat_statements.track_planning=on
node scripts/benchmarks/proof-format/run.mjs
```

Wait for PostgreSQL readiness before running. The script checks the local Unix Docker
context, exact fixture container/image and localhost port; it never accepts a
production database URL. It creates a uniquely named synthetic database. Its results
file is ignored by Git; the reviewed raw artifact is under `docs/benchmarks`.
Stop only the disposable fixture container after testing.

Before rollout, validate representative proof histories (including negotiation and
large associations), database planning/execution time, errors, overflow frequency and
p95/p99 latency. Rollback restores the prior didcomm patch and rebuilds dependencies;
no schema or persisted-data migration is required. No deployment, AWS mutation or
RDS resize is authorized or performed by this PR.
