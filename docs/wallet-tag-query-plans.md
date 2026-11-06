# Wallet tag-query planning

Credo reads records with tag searches (`findByQuery`, `findSingleByQuery`). Askar turns each tag
condition into a subquery:

```sql
SELECT … FROM items i WHERE profile_id = $1 AND (kind = $2 OR $2 IS NULL) AND (category = $3 OR $3 IS NULL)
  AND i.id IN (SELECT item_id FROM items_tags WHERE name = $4 AND value = $5 AND SUBSTR(value, 1, 12) = $6 AND plaintext = 0)
  AND …
```

On a shared agent the wallet of a busy tenant holds hundreds of thousands of records. Two shapes of
this SQL then stop using the tag index and read a large part of the tenant's records for every
lookup:

1. **OR queries.** `(i.id IN (…) OR i.id IN (…))` cannot become a join. PostgreSQL reads every item
   of the profile (generic plan) or of the category (custom plan) and tests each one. Credo issues
   OR queries on hot paths:
   - `DidCommConnectionRepository.findByDids`: every inbound message on a connection;
   - the inbound envelope's out-of-band key lookup (`DidCommEnvelopeService`);
   - `DidRepository.findCreatedDid`, `findReceivedDid` and `findAllByDid`: DID resolution.
2. **AND queries led by a common tag.** Askar emits a query object's conditions in sorted key order
   (`serde_json` maps are sorted). A cached generic plan cannot tell a selective value from a common
   one, so it walks the first condition's index range. `DidCommBaseProofProtocol.findByProperties`
   runs `{ threadId, role }` on every inbound presentation of a connectionless proof request.
   `role` sorts first, so the lookup walks every exchange of the tenant with that role.

Per-execution planning (`--wallet-postgres-statement-cache-capacity=0`, see
[postgres-query-planning.md](postgres-query-planning.md)) fixes the second shape, because a custom
plan sees the values. It does not fix the first: the OR form reads the whole category under every
plan.

## What the controller does

`PlanStableAskarStorageService` (`src/storage/`) replaces Credo's `AskarStorageService` and changes
only `findByQuery`. Writes, `getById` and `getAll` are Credo's. `planTagQuery` rewrites each query
in one of two ways:

- **OR → union.** The query is expanded into the AND-only branches whose union matches the same
  records (at most `MAX_OR_BRANCHES` = 8; Credo's hot paths need 3).
  - Each branch runs as its own lookup, one after another, bounded by the caller's `limit`.
  - Results are merged by record id.
  - `$not` stays inside each branch as written.
- **AND → selective tag first.** The conditions are passed as an `$and` array, which Askar keeps in
  order. The order is:
  1. unique identifiers (thread ids, DIDs, key fingerprints, record ids);
  2. grouping identifiers (`connectionId`, `outOfBandId`, `tenantId`, credential definition ids, …);
  3. enumerations, booleans and operator values (`role`, `state`, protocol names, …);
  4. operators such as `$not`.

  A query whose sorted order already leads with a selective tag is not touched.

The set of matched records is unchanged. Absent values (`undefined`, `null`, `[]`) and empty `$and` /
`$or` arrays are dropped exactly as Askar drops them. Where the result could differ, the original
query runs instead:

- **`offset` or `orderBy`** on an OR query: a page of a union cannot be cut without Askar's internal
  row order.
- **More distinct matches than `limit`:** the stock query might pick a different subset. For
  `findSingleByQuery` (limit 2) that is only the duplicate-record error path.
- **Shapes outside the planner:** more than 8 branches, or an alternative with no condition.

Without `orderBy`, Askar applies no `ORDER BY`, so the order of an unpaged result was never defined.

**One semantic difference.** Each branch is its own statement. A record that changes, between two
branch statements, from matching only a later branch to matching only an earlier one is missed by
that call. The tag changes Credo makes go the other way (a DID rotation moves a DID from `did` /
`theirDid` into `previousDids` / `previousTheirDids`), and the union finds the record in either
order.

The planner itself costs about 0.4–3.5 µs per query on a laptop CPU.

## Configuration and rollback

`WALLET_QUERY_PLANNING`:

- `on` or unset: planned queries.
- `off`: registers Credo's stock `AskarStorageService`, so every query runs exactly as before.
- Any other value fails startup.

The setting applies to the root agent and every tenant. Rollback means setting it to `off` and
replacing the tasks; there is no schema or data change.

The statement cache setting is independent. Planned queries are fast with the cache on or off.

## Results

### Fixture

The fixture is a local PostgreSQL 16 (2 CPUs, `shared_buffers` 512 MB, `work_mem` 64 MB) with real
native Askar 0.6.1 records written through Credo's tag encoding:

- One large verifier tenant with 264,000 items, from 60,000 exchanges. Each exchange is a
  connectionless proof request, its request message, its OOB invitation and its invitation's peer
  DID. One exchange in ten also has a connection and its two DID records.
- Six small tenants (13,200 items each).
- 78,000 tenant routing records in the root profile.

That is 421,200 items and 2,067,000 tags in total. For scale, the largest tenant profile seen in a
production plan had about 614,000 items.

### Method

Each query is the exact query object Credo 0.6.2 builds on that path, copied from the installed
sources. It runs against the large tenant on a single pooled connection, which reuses its prepared
statements like a busy production connection.

The three planning modes:

- **`cache100`:** SQLx's default statement cache and PostgreSQL's `plan_cache_mode = auto`. This is
  production's configuration.
- **`cache0`:** per-execution planning.
- **`generic`:** `plan_cache_mode = force_generic_plan`, the worst case.

Buffers are `shared_blks_hit + shared_blks_read` from `pg_stat_statements` for the wallet scan
statements. The tables show medians of three trials' per-trial p50 / p95 (60 lookups per query per
trial, after 8 warm-up executions). The second trial ran planned before stock. Every lookup
returned the expected single record: 11,880 measured lookups, 0 mismatches. Raw results are in
[benchmarks/wallet-tag-plans.json](benchmarks/wallet-tag-plans.json).

### Default statement cache (`cache100`)

| Query (Credo call site)                                        | Stock p50 / p95 ms | Stock buffers | Planned p50 / p95 ms | Planned buffers | Statements |
| -------------------------------------------------------------- | -----------------: | ------------: | -------------------: | --------------: | ---------: |
| `{ threadId, role }`: proof `findByProperties`, connectionless |    289.39 / 304.75 |       508,827 |          0.52 / 0.82 |              22 |          1 |
| created DID by DID (`findCreatedDid`, AND + OR)                |    156.26 / 175.40 |       291,167 |          1.01 / 1.90 |              21 |          2 |
| OOB by recipient key (envelope, OR of AND)                     |    153.28 / 165.14 |        74,442 |          0.74 / 1.85 |              25 |          2 |
| all DIDs by DID (`findAllByDid`, OR)                           |      84.09 / 91.94 |        46,833 |          0.73 / 1.98 |              21 |          2 |
| connection by DIDs (`findByDids`, OR of 3 ANDs)                |        5.76 / 8.15 |         6,171 |          1.08 / 2.26 |              43 |          3 |
| created DID by key (AND2)                                      |        1.19 / 1.70 |            17 |          0.41 / 1.02 |              17 |          1 |
| agent message (AND5)                                           |        0.40 / 0.86 |            30 |          0.53 / 1.14 |              30 |          1 |
| agent message, any role (AND4)                                 |        0.46 / 0.80 |            26 |          0.62 / 1.06 |              26 |          1 |
| OOB by invitation (AND3)                                       |        0.50 / 1.01 |            21 |          0.60 / 1.31 |              21 |          1 |
| proof by thread (AND1)                                         |        0.40 / 1.15 |            18 |          0.37 / 0.82 |              18 |          1 |
| tenant routing by key (root)                                   |        0.39 / 0.67 |            13 |          0.38 / 0.75 |              13 |          1 |

### Per-execution planning and forced generic plans

The planned lookups stay at 13–43 buffers and at or below 3 ms p50 in both other modes:

- **Stock `cache0`:** fixes `{ threadId, role }` (0.95 ms). The OR shapes still read 31,713–74,442
  buffers per lookup (45–153 ms p50).
- **Stock `generic`:**
  - `{ threadId, role }`: 285 ms;
  - `findByDids`: 78 ms and 46,853 buffers;
  - the other OR shapes: 81–154 ms.

The shapes that were already fast keep the same plan and buffer counts in every mode. Their
p50 differs by a few tenths of a millisecond either way between trials.

### What this does not establish

These are synthetic single-lookup timings on a laptop. They are not production request latency or
a database capacity figure. The tag distribution is shaped like a busy verifier tenant. Other
tenants (holders with many credentials, issuers) have other hot queries.

The production effect should be measured after a staged rollout:

- wallet scan statement load and buffers per call;
- connection pool occupancy;
- inbound DIDComm and API latency tails;
- database CPU.

Compare against an equivalent traffic window.

## Reproduction

Requires local Docker, Node 22.22.2 and installed dependencies. The scripts only touch the
disposable container they are given. `bench.mjs` refuses a non-local Docker context.

```sh
docker run --rm -d --name wtqp-pg16 --cpus 2 --memory 3g --shm-size 512m \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=fixture -e POSTGRES_DB=fixture \
  -p 127.0.0.1:55432:5432 postgres:16 -c shared_preload_libraries=pg_stat_statements \
  -c shared_buffers=512MB -c work_mem=64MB -c jit=off -c effective_cache_size=2GB
yarn build
node scripts/benchmarks/wallet-tag-plans/seed.mjs 55432 wtqp /tmp/wtqp-manifest.json 60000 6 3000
docker exec wtqp-pg16 psql -U fixture -d wtqp -c 'VACUUM ANALYZE'
for t in 1 2 3; do
  node scripts/benchmarks/wallet-tag-plans/bench.mjs 55432 wtqp-pg16 /tmp/wtqp-manifest.json /tmp/wtqp-$t.json 60
done
node scripts/benchmarks/wallet-tag-plans/summarize.mjs docs/benchmarks/wallet-tag-plans.json /tmp/wtqp-{1,2,3}.json
docker stop wtqp-pg16
```

The manifest holds the fixture wallet's raw key. It is a disposable local key; keep the file out
of the repository.
