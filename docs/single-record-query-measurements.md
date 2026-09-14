# Synthetic query-path measurements

These measurements cover the two patches together: a two-match bound for
single-record queries and native scan result-list cleanup. They do **not**
establish a general latency improvement or justify a smaller database instance.

## Method

Local PostgreSQL 16.15, Node 20.19.4, Credo 0.6.2, Askar shared wrapper 0.4.3 and
native Askar 0.4.6. The fixture has 11,000 synthetic records, five tags each and
approximately 1 KiB of content per record. One intentionally duplicated exchange
ID matches 1,000 records; the other 10,000 exchange IDs are unique.

Two repeats were attempted for each mode/scenario, alternating before/after
order. Each run had 20 warm-up and 200 measured sequential operations. Baseline
mode reproduces the former unbounded query and omitted native result-list free.
Successful results were recorded only after store cleanup completed. Failed runs
are retained in the [raw synthetic results](benchmarks/single-record-query.json).
See the [benchmark instructions](single-record-query-bound.md#local-postgresql-benchmark)
to reproduce the fixture and workload.

Numbers below are medians of completed per-run measurements, **not pooled
percentiles**. This small, warm-cache experiment on a shared local machine is not
a statistical confidence claim or a concurrent production workload test.

## Latency and throughput

| Scenario                | Completed before / after | p50 ms before → after | p95 ms before → after | p99 ms before → after | Operations/sec before → after |
| ----------------------- | ------------------------ | --------------------- | --------------------- | --------------------- | ----------------------------- |
| Unique match            | 2/2 / 2/2                | 0.87 → 0.98           | 1.66 → 1.79           | 2.54 → 3.08           | 987 → 867                     |
| Missing match           | 0/2 / 2/2                | unavailable → 0.56    | unavailable → 1.24    | unavailable → 1.62    | unavailable → 1,654           |
| 1,000 duplicate matches | 2/2 / 2/2                | 219.49 → 2.27         | 344.76 → 4.41         | 827.51 → 9.98         | 4.01 → 396.26                 |

Duplicate-heavy lookup latency improved substantially while still returning the
same duplicate-record error. **Unique lookup latency did not improve overall in
this sample**; its p95 and p99 were higher. No baseline missing-match latency can
be inferred from failed runs. Do not generalize the duplicate-case speedup to
normal proof or credential traffic.

## Database work and resource ownership

| Metric per lookup                       | Unique before → after | Duplicate-heavy before → after |
| --------------------------------------- | --------------------- | ------------------------------ |
| SQL result rows                         | 1 → 1                 | 1,000 → 2                      |
| PostgreSQL execution time, ms           | 0.0434 → 0.0540       | 14.2548 → 0.6252               |
| Shared buffer hits                      | 22.225 → 22.225       | 18,319 → 131                   |
| Native result lists acquired / released | 1/0 → 1/1             | 32/0 → 1/1                     |

Completed runs had zero measured physical block reads and temporary-block I/O.
They therefore demonstrate logical query work under warm-cache conditions, not
storage-device performance. PostgreSQL execution time is not a direct CPU-time
measurement. Application CPU and whole-process peak RSS are also recorded in the
raw results; they must not be treated as database memory requirements.

## Stability limits and review gate

Both baseline missing-match runs failed to complete, including an outer timeout.
Longer exploratory runs (1,000 warm-up / 2,000 measured operations) also encountered
native failures or incomplete cleanup in baseline and candidate paths. Some
reported native `Napi::Error` aborts or exit code 13. These observations do not
establish the cause, and they are not silently excluded from the conclusion.

The repository's functional regression tests and native ownership checks are
separate evidence from sustained-load stability. Keep the performance change in
draft until the native benchmark instability is understood and repeatable
normal-traffic latency results are available. A production capacity claim also
requires representative query plans, index statistics, workload attribution,
throughput, tail-latency and peak-load validation.

The demonstrated benefits are bounded duplicate materialization and correct
native result-list release. A general latency or database-sizing benefit remains
unproven.
