# Priority 4: bounded list reads and tenant admission

This change adds optional proof/OOB pages and repairs tenant-session admission before restoring finite budgets. Existing complete-list callers keep their array response and one storage search. There is no wallet schema change, data migration, deletion, retention change, cache-policy change, or deployment in this PR.

## Choose the query for the caller's actual requirement

| Requirement               | Request                                                     | Storage behavior                                      |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Every matching proof      | `GET /didcomm/proofs` or `GET /didcomm/proofs?threadId=...` | One complete-list search; no internal pagination loop |
| Every matching OOB record | `GET /didcomm/oob` or `GET /didcomm/oob?invitationId=...`   | One complete-list search; no internal pagination loop |
| One proof page            | `GET /didcomm/proofs?limit=100&offset=0`                    | Fetch at most 101 records; return at most 100         |
| One filtered OOB page     | `GET /didcomm/oob?invitationId=...&limit=100&offset=0`      | Same bound, retaining the filter and tenant context   |

Do not reconstruct complete lists by repeatedly requesting pages. That adds database searches, repeated offset scanning and lookahead records. The complete-list path deliberately remains a single search, including lists larger than the maximum page size; controller regression tests enforce this for both endpoints. Paging saves work only when the caller needs part of the result. A full export still has to read every matching record.

The current platform cloud-wallet `getProofPresentation` builds one proof-list request, optionally filtered by thread ID. The agent-service `getProofPresentations` bridge also forwards one HTTP GET. They keep their existing full-result contract and require no pagination loop or wrapper change. The main verification list queries the platform's own repository, a separate path. The reviewed issuance wrapper source did not expose a direct proof/OOB list consumer. This is a source review of available callers, not a claim about every external API client.

New page consumers must explicitly adopt the contract. Do not add `limit` to an existing complete-result caller without changing its product/API contract. Existing callers receive no pagination savings merely from deploying this PR.

## Page contract and consistency

- Omit both paging parameters for the existing complete-list response. No default cap is applied to that path.
- `limit` is an integer from 1 through 1000. `offset` defaults to zero and requires `limit`; it must be a non-negative safe integer within the accepted continuation range.
- Responses remain arrays. `X-Has-More`, `X-Page-Limit`, and `X-Page-Offset` describe the page. `X-Next-Offset` is present only when the lookahead record establishes another page. These headers are exposed when the existing CORS option is enabled.
- The Askar adapter forwards `orderBy: 'id'` for opted-in pages. This is the native internal insertion order, not lexicographic record UUID order or a new database column/index. Legacy searches do not acquire an ordering requirement.
- These are **live pages, not snapshots**. Updating an existing record retains its position in the tested native store. Insertions, deletion, filter changes, and deletion/reinsertion can change later pages. An offset may skip a record after an earlier deletion. The native regression test makes this limitation explicit.
- Static traversal is tested for ordering, no duplication or omission, exact end-of-list behavior, filters and tenant isolation. There is no total-count query.
- Deep offsets cost more database work. Do not use page traversal for a complete snapshot, wallet migration, or full export. Use the complete-result operation when every record is required. A future bounded-memory, snapshot export needs a separately designed streaming/transaction lifecycle; this PR does not introduce persistent cursors or hold transactions between HTTP requests.

## Tenant admission and overload

The prior mutex can strand waiting callers even after slots become available. The replacement admits callers in FIFO order, transfers a released slot directly to the oldest live waiter, removes timed-out waiters, and bounds the pending queue. It checks a monotonic deadline on release as well as using timers, so a delayed event loop cannot admit an expired waiter. Timeout applies to acquiring a slot, not to cancelling already-admitted work.

Controller settings, read at startup:

| Setting                   | Default                   | Accepted values  |
| ------------------------- | ------------------------- | ---------------- |
| `SESSION_LIMIT`           | 10 active sessions        | Integer 1–10000  |
| `SESSION_ACQUIRE_TIMEOUT` | 10000 ms                  | Integer 1–600000 |
| `SESSION_PENDING_LIMIT`   | 1000 waiting acquisitions | Integer 1–10000  |

Unset settings receive defaults. Blank, zero, fractional, non-finite, exponent-form, unsafe or out-of-range values fail startup; validation errors name the setting without printing its value. Audit existing configuration before rollout. Explicit valid limits are retained. These finite defaults intentionally replace the controller's unbounded fallback.

Budgets are **per process**, shared by tenant-session consumers in that process. Sessions are not database connections, and this is not a global cap across replicas. The per-tenant initialization/shutdown mutex retains its existing timeout behavior; the acquisition budget is not an end-to-end request deadline. Set the pending limit using request memory, arrival rate and acceptable waiting time, rather than treating its maximum as a target.

Queue overflow and admission expiry produce a tagged internal error. HTTP authentication and controller error conversion map that error to a fixed **503** response. Other authentication and Credo errors retain their handling. There are no automatic retries of issuance, verification or other side effects. Callers must use an appropriate bounded retry/idempotency policy.

HTTP cleanup releases a tenant session once after the response ends, including `end()` after a client disconnect. A `close` event alone does not release it while controller work is still running. Cleanup rejection is handled with a fixed log message. A real localhost HTTP test exercises disconnect followed by completed work. Existing initialization/callback failure cleanup remains intact. Work that never settles can still occupy its slot; admission does not forcibly terminate it or close its wallet.

## Validation and reproduction

The tests cover legacy results above the maximum page size, lookahead/continuation, rejected inputs, native repository ordering/filtering/isolation, live mutation semantics, concurrent admission, FIFO transfer, overflow, timeout removal, delayed timers, failure recovery and HTTP disconnect cleanup.

The full patch sequence was applied using `patch-package --error-on-fail` to fresh published 0.6.2 package tarballs. Patched package files were compared byte-for-byte with the installed files. The ordered Askar patch uses a separate sequence filename to coexist with priority 1's configuration patch. Generated TSOA routes and OpenAPI include the optional parameters.

Run normal validation with the locked dependencies:

```sh
yarn install --frozen-lockfile
yarn validate
yarn test --runInBand
yarn build
```

The admission benchmark is entirely synthetic and needs no database:

```sh
node scripts/benchmarks/tenant-admission/run.mjs
```

For the longer PostgreSQL benchmark, first apply priority 1's native FFI callback-lifetime and Scan result-cleanup prerequisites in a **disposable benchmark checkout**. Both complete and paginated modes use the same prerequisites. The benchmark records the native binary/source hashes. These prerequisites are not bundled into priority 4, and their benefits are not attributed to pagination. A preliminary run with the uncorrected native binary failed while seeding, before comparable query measurements; it is excluded from the results. Standalone branch regression tests are run with the original installed native dependencies.

The benchmark accepts only its named local Docker fixture and checks the image and loopback binding; it does not accept a database connection string or production credentials:

```sh
docker run --detach --name codex-priority4-postgres \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=fixture --env POSTGRES_PASSWORD=fixture \
  --env POSTGRES_DB=fixture postgres:16.13 \
  -c shared_preload_libraries=pg_stat_statements \
  -c pg_stat_statements.track_planning=on
node scripts/benchmarks/record-pages/run.mjs
docker stop codex-priority4-postgres
```

Only synthetic local wallet records are created/updated/deleted by fixtures. Store handles are closed in `finally`. The disposable database/container may be removed by the developer after reviewing their local fixture; no cloud cleanup is part of these commands.

## Measurements

Local PostgreSQL 16.13, Node 22.22.2, 2,000 synthetic records per category, 100-record pages, concurrency one, 20 operations per mode per trial, three trials with alternating mode order. Other tests were stopped during the final benchmark. Values below are medians of the three trial summaries; individual trials and outliers are retained in [raw results](../../scripts/benchmarks/record-pages/results.json).

| Query requirement/mode                              | Proof p95 (ms) | OOB p95 (ms) | Proof DB planning + execution (ms / 20 operations) | OOB DB planning + execution (ms / 20 operations) | Searches / operation |
| --------------------------------------------------- | -------------: | -----------: | -------------------------------------------------: | -----------------------------------------------: | -------------------: |
| Complete result, retained single search             |         400.53 |       671.58 |                                             167.75 |                                           195.44 |                    1 |
| First page only                                     |          43.98 |        54.05 |                                              11.76 |                                            25.42 |                    1 |
| Last page only (offset 1900)                        |          73.84 |        52.30 |                                             174.25 |                                           156.60 |                    1 |
| Negative control: reconstruct everything with pages |         681.32 |       745.79 |                                            1504.57 |                                          1868.68 |                   20 |

A first page decodes 101 records instead of 2,000 (94.95% fewer); the extra record is lookahead. The first-page and complete-result numbers represent **different amounts of requested data**, not an equivalent-workload universal speedup. Timings cover repository lookup and correctness assertions, not HTTP/network latency. All measured reads hit database buffers; cold-storage behavior is unmeasured. The recorded `idArrayBytes` is a synthetic ID array, not the actual HTTP response size.

For complete-result consumers, retaining one search avoids the negative control's 20 searches and approximately 9–10 times the measured database planning/execution work. It preserves baseline work, rather than claiming a new reduction on an already single-query caller. Deep pagination is not a database CPU saving in every case: the last proof page was slightly more expensive in database time than the complete query. Pagination is therefore not prescribed for full traversal.

The [admission benchmark](../../scripts/benchmarks/tenant-admission/results.json) uses 30 concurrent synthetic jobs, 2 ms of work, a three-session cap and a 150 ms acquisition budget. In all three trials the old mutex completed 3 jobs and timed out 27; the candidate completed all 30, with peak active sessions 3 and final occupancy zero. The candidate drained the burst in about 22 ms. Successful-only latency percentiles are not comparable here because the baseline excluded most jobs through failure. This demonstrates admission recovery and bounded concurrency, not a production throughput or RDS-capacity estimate.

Standalone validation: 38 suites / 398 tests passed, followed by 22 passing pagination tests including two additional full-list regression cases (400 total test cases). Lint, both type checks, formatting and clean patch application passed. The final CI run validates the committed revision.

## Rollout and capacity decision

Before an authorized rollout, integrate the native safety prerequisites, validate the combined patch sequence, verify environment budgets and caller behavior, and run representative tenant/issuance/proof load. Start with a canary and compare accepted/completed throughput, error/503 rate, queue wait, end-to-end p50/p95/p99, memory, active sessions, database CPU/load, I/O and connection use. Include cold tenants, skewed tenant traffic and clients that disconnect.

Adopt pagination only for page-sized product needs. Complete-result callers keep the single-search path. If overload or acceptable throughput worsens, review the configured limits and roll back the application release or configuration through the approved deployment process. No database rollback or data migration is needed for this code.

These measurements do not establish a universal latency improvement, a safe smaller database instance, or a percentage cost saving. A later database resize requires sustained representative-load headroom and a tested rollback; a session limit cannot be converted directly into an instance-size reduction.
