# Synthetic query-path measurements

The native callback failure exposed by the initial benchmark has been traced and
corrected. The refreshed matrix completed **21 of 21 processes**, including
46,320 lookups with warm-up and normal process exits. See the
[native lifecycle investigation](native-callback-lifecycle.md) for the cause,
negative control and installation requirements.

This resolves the observed benchmark lifecycle failure. It does **not** establish
a general latency improvement or justify a smaller database instance.

## Method

Local PostgreSQL 16.15, official Node 22.22.2 (matching the Dockerfile), libuv
1.51.0, Credo 0.6.2, Askar shared wrapper 0.4.3 and native Askar 0.4.6. The fixture
has 11,000 synthetic records, five tags each and approximately 1 KiB of content
per record. One intentionally duplicated exchange ID matches 1,000 records; the
other 10,000 exchange IDs are unique.

Three repeats were run per mode/scenario, alternating before/after order. Unique
and missing scenarios each use 1,000 warm-up and 2,000 measured operations per
run. Duplicate comparisons use 20 warm-up and 200 measured operations: baseline
mode deliberately retains the old result-list leak, so increasing that workload
indefinitely would become an artificial memory-exhaustion test. Three additional
candidate duplicate runs each completed 1,000 warm-up and 2,000 measured operations.

**Both modes include the native callback race correction.** Baseline mode alone
omits the single-record query limit and native result-list release. This isolates
the two query-path changes from the callback correction. A parent process requires
both valid result JSON and normal child exit; aborts, timeouts and incomplete
reports cannot become successful latency samples.

Numbers below are medians of three completed per-run measurements, **not pooled
percentiles**. This warm-cache, sequential workload on a shared local machine is
not a statistical confidence claim or a concurrent production capacity test.
The [raw refreshed results](benchmarks/single-record-query-stability.json) include
all 21 outcomes. See the [benchmark instructions](single-record-query-bound.md#local-postgresql-benchmark)
and run `node scripts/benchmark-single-record-query-suite.mjs` to repeat the matrix.

## Latency and throughput

| Scenario                | Completed before / after | p50 ms before → after | p95 ms before → after | p99 ms before → after | Operations/sec before → after |
| ----------------------- | ------------------------ | --------------------- | --------------------- | --------------------- | ----------------------------- |
| Unique match            | 3/3 / 3/3                | 0.73 → 0.71           | 2.03 → 1.75           | 4.75 → 6.96           | 941 → 980                     |
| Missing match           | 3/3 / 3/3                | 0.29 → 0.37           | 0.62 → 0.93           | 0.86 → 1.42           | 2,654 → 1,901                 |
| 1,000 duplicate matches | 3/3 / 3/3                | 213.18 → 1.49         | 384.94 → 3.87         | 646.03 → 10.95        | 4.28 → 507                    |

Duplicate-heavy lookups improved substantially while preserving the same
error. Normal-case latency remains mixed: unique p95 improved but p99 rose,
and missing-match latency increased. Do not generalize the duplicate-case speedup
to normal proof or credential traffic. The bounded query does not avoid work
needed to establish that a match is absent or unique.

## Database work and resource ownership

| Metric per lookup                       | Unique before → after | Missing before → after | Duplicate-heavy before → after |
| --------------------------------------- | --------------------- | ---------------------- | ------------------------------ |
| SQL result rows                         | 1 → 1                 | 0 → 0                  | 1,000 → 2                      |
| PostgreSQL execution time, ms           | 0.0422 → 0.0391       | 0.0059 → 0.0085        | 15.6940 → 0.4946               |
| Shared buffer hits                      | 22.2255 → 22.2255     | 3 → 3                  | 18,319 → 131                   |
| Native result lists acquired / released | 1/0 → 1/1             | 0/0 → 0/0              | 32/0 → 1/1                     |

Completed runs had zero measured physical block reads and temporary-block I/O.
They demonstrate logical query work under warm-cache conditions, not storage-device
performance. PostgreSQL execution time is not a direct CPU measurement.
Application CPU and whole-process peak RSS are recorded in the raw results and
must not be treated as database memory requirements.

## Earlier failures and remaining review limits

The [initial synthetic results](benchmarks/single-record-query.json) are retained
as historical evidence; their interrupted runs and different runtime must not be
pooled with this refreshed matrix. Missing baseline runs previously failed, and
longer runs exposed native aborts or incomplete exit in both modes. The
[lifecycle fix](native-callback-lifecycle.md) addresses that failure rather than
hiding it with forced exits, error suppression, or skipped cleanup.

The native benchmark failure is no longer an unresolved review gate. Functional
and stress tests remain finite evidence. Representative query plans, index
statistics, normal-traffic tail latency, throughput and peak-load validation are
still required before claiming a general performance gain or reducing database
capacity. The PR remains available as a draft for review; these measurements are
not deployment or database-sizing approval.
