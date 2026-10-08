# Opt-in PostgreSQL query planning

Prepared statements can become slower when PostgreSQL selects a generic plan for
parameter-sensitive wallet tag searches. Generic plans cannot use the actual
profile, category or tag values to choose an access path. The default `auto`
policy compares estimated costs, so an inexpensive estimate does not guarantee
inexpensive execution.

This change exposes `statementCacheCapacity` in the PostgreSQL wallet configuration.
Setting it to **0** disables SQLx's per-connection statement cache, causing each
execution to be planned with its parameters. It does not disable parameter binding,
change SQL predicates, split a query into multiple snapshots, or change transaction,
wallet encryption, record limits or tenant isolation semantics.

The setting is **opt-in**. Omission preserves the native default (100 cached
statements per connection in SQLx 0.8.6). Replanning adds overhead to already-fast
queries, including writes and record-by-name lookups. Do not enable it for every
workload without measurement.

## Configuration and rollback

CLI:

```sh
--wallet-postgres-statement-cache-capacity=0
```

The existing prefixed environment/config parser also accepts
`AFJ_REST_WALLET_POSTGRES_STATEMENT_CACHE_CAPACITY=0` or the JSON property
`"wallet-postgres-statement-cache-capacity": 0`.
Programmatic callers can set `walletConfig.database.config.statementCacheCapacity`
for PostgreSQL. Values must be integers from 0 through 10000. Zero is preserved;
invalid values fail without echoing input or credentials.

A version-pinned patch to `@credo-ts/askar@0.6.2` forwards this as the supported
SQLx URI parameter `statement-cache-capacity`. No server startup parameter or
PgBouncer configuration change is introduced. Existing pool and timeout settings
remain effective. The native library's connection handling must be reverified if
Askar or SQLx is upgraded.

After an approved deployment, rollback means removing the setting (or restoring
its prior positive value) and replacing the affected application processes through
the normal deployment mechanism. Existing open pools retain their configuration.
There is no database schema migration or data rollback.

## Synthetic mixed-read results

PostgreSQL **16.13**, 200,000 synthetic items, 1,200,000 tags, 28 profiles and skewed
profile/category distributions. Records have six tags, mixing unique identifiers
with common role/protocol values. The SQL workload exercises AND2/3/4/5, OR2 and
OR-of-three-AND-pairs equally; 25% of requests are missing matches. Measured requests
use the largest profile. It is a deliberately parameter-sensitive fixture, not a
production replay or a representative sample of every application operation.

Four workers issue the same deterministic request sequence per trial. Three repeats
alternate comparison order. The cache-enabled baseline uses PostgreSQL's normal
`auto` policy, **not forced generic planning**. The candidate uses unnamed extended
protocol executions. Native Askar was checked separately: 20 identical-shape lookups
produced six plans with capacity 100 and 20 plans with capacity 0; all returned the
expected record. Native CRUD, missing lookups, OR filtering, transaction rollback
and profile isolation also passed with caching disabled.

At a fixed offered rate of **150 lookups/second**, medians of three per-run results:

| Configuration | CPU quota |      p50 |       p95 |       p99 | DB CPU seconds / 1,920 lookups |
| ------------- | --------: | -------: | --------: | --------: | -----------------------------: |
| Cached / auto |         4 | 46.10 ms | 173.66 ms | 250.08 ms |                          35.02 |
| Uncached      |         4 |  3.29 ms |  25.15 ms |  31.34 ms |                          10.32 |
| Uncached      |         2 |  3.37 ms |  25.79 ms |  32.08 ms |                          10.30 |

With half the CPU quota, this fixture reduced p95 by **85.2%**, p99 by **87.2%**,
and measured CPU work by **70.6%**. The candidate sustained the offered rate.
The baseline completed approximately 148.4 lookups/second after draining its queues;
the candidate completed approximately 150.1. Latency includes delay behind earlier
requests on each worker, avoiding omission of this queueing cost.

At unpaced saturation, median throughput was 214.6 lookups/second for the 4-CPU
baseline, 995.5 for the 4-CPU candidate and 394.1 for the 2-CPU candidate. At half CPU,
saturation p95 was 67.70 ms versus 79.81 ms; p99 was 81.21 versus 84.22 ms. These are
closed-loop, four-worker saturation measurements, not maximum database capacity.

All **18 trials / 34,560 measured lookups** completed with zero result mismatches.
Warm-ups are excluded. Raw per-run results, including per-shape percentiles, are in
[postgres-planning.json](benchmarks/postgres-planning.json). Percentiles above are
medians of per-run percentiles, not pooled percentiles or confidence intervals.

## What this establishes, and the remaining gate

This establishes a mixed-read latency and CPU improvement on the documented fixture,
and successful operation at half its CPU quota. It extends the earlier duplicate-only
benefit; it does **not** establish a universal per-query latency improvement.
Some already-fast shapes pay more planning overhead, which is why the option is
not enabled by default.

It does not certify halving a production database. The benchmark uses synthetic
ciphertext-shaped SQL values, not native encrypted records at this scale; the
PostgreSQL protocol driver is psycopg 3.2.10. It excludes API/network/cryptographic
latency, writes, large list operations, replica behavior and storage pressure.
Memory remains 2 GiB in both CPU tests. Halving CPU quota does not simulate halving
RAM or an RDS instance's network and storage limits. Container CPU deltas include
small sampling and connection-close overhead, so brief saturated samples can
slightly exceed nominal quota utilization.

After review and explicit deployment approval, compare a controlled rollout at the
**existing database size** against an equivalent workload window. Measure endpoint
and query p50/p95/p99, throughput, errors/timeouts, DB CPU/AAS, planning overhead,
buffer work, read/write latency, connections, free memory and replica lag where
applicable. Include busy periods, writes, and list operations. Stop or roll back if
latency/error objectives regress. Estimate resize headroom from the resulting peak
CPU **and** memory/I/O demand; approve any resize separately. This PR neither deploys
the setting nor resizes infrastructure.

## Reproduction

Requires local Docker, Node 22.22.2, installed repository dependencies, and Python
with `psycopg[binary]==3.2.10` (install in a temporary virtual environment). Scripts
reject remote Docker contexts and target only their dedicated localhost fixture.
Do not reuse the container name for anything else. Start with a fresh container:

```sh
docker run --rm -d --name codex-credo-capacity-pg16 --cpus 4 --memory 2g --shm-size 256m -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:16.13 -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track_planning=on -c shared_buffers=256MB -c work_mem=16MB -c jit=off
python scripts/benchmarks/postgres-planning/seed.py
python scripts/benchmarks/postgres-planning/benchmark.py
node scripts/benchmarks/postgres-planning/native-cache-check.cjs
```

Wait for PostgreSQL readiness before seeding. The benchmark changes **only this local
container's** CPU quota, and writes raw results next to its script. The native check
creates a separate synthetic wallet and resets only this disposable cluster's query
counters. Inspect exit status, result counts and errors before interpreting timings.
After collecting results, stop this specific disposable container; `--rm` removes it.

References: PostgreSQL [prepared-plan selection](https://www.postgresql.org/docs/16/sql-prepare.html)
and the pinned SQLx [URI parser](https://github.com/launchbadge/sqlx/blob/v0.8.6/sqlx-postgres/src/options/parse.rs).
