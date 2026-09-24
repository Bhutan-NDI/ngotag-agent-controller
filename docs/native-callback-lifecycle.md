# Native callback lifecycle fix

The incomplete missing-record runs, native aborts and processes that hung after
store closure were traced to `@2060.io/ffi-napi` 4.0.9's callback dispatcher.
This dependency is used by the existing Askar Node bindings; the failure also
reproduced with the original unbounded wallet query behavior.

## Cause and evidence

`CallbackInfo::Invoke` called `uv_ref` and `uv_unref` on one shared async handle
from native worker threads. Those operations modify loop-owned reference state.
They raced with loop-thread activity and with other native callback completions.
The source already labels its worker-thread reference operation a race.

The observed outcomes match damaged event-loop reference bookkeeping:

- Premature loop termination with unsettled native promises (exit code 13).
- A `Napi::Error` abort in `CallbackInfo::DispatchToV8` / `WatcherCallback` while
  native callbacks arrive during termination.
- A live loop after all queries and store closure completed, despite no active
  referenced work in the diagnostic handle inventory.

This reproduced on both the initial Node 20 environment and the official Node
22.22.2 runtime pinned by the Dockerfile, with unmodified native source. On the
latter, only two of six 3,000-lookup baseline missing-record processes exited
successfully: two timed out, one aborted, and one exited with code 13.

Removing only the worker-thread reference mutations eliminated these outcomes
in ten alternating baseline/candidate missing-record runs (3,000 lookups each).
A separate SQLite lifecycle regression passed three fresh processes with 4,020
queries each, including concurrent callbacks, forced garbage collection, an
invalid-profile error, and 20 close/reopen cycles. Restoring the original native
source made one of three control processes hang even after printing its completed
cleanup report. These are finite regression/stress checks, not a universal
absence-of-races guarantee.

Sources:

- [Dispatcher source](https://github.com/2060-io/node-ffi-napi/blob/30d272f2821b4ce7a22d3f048aa78465214d1b45/src/callback_info.cc)
- [libuv design: loop and handle thread safety](https://docs.libuv.org/en/v1.x/design.html)
- [libuv handle reference counting](https://docs.libuv.org/en/v1.x/handle.html)

## Fix and lifetime contract

The version-pinned native patch removes the two cross-thread reference mutations.
It preserves callback dispatch, queue locking, condition-variable signalling and
callback results. The async watcher remains unreferenced as initialized upstream.

The caller must keep its pending asynchronous operation alive. Askar already
retains each pending callback with a JavaScript timer until completion; Indy VDR
uses the same pattern. Their lifetime ownership remains intact. The patch does
not add timers, suppress errors, force successful process exits, or change any
wallet query, cryptographic operation, schema or public API.

The FFI dependency is shared, so this correction applies to its native callback
dispatch rather than just one query function. New users of raw FFI callbacks must
also own their asynchronous lifetime; a callback pointer alone is not a pending
Node.js resource. Synchronous FFI calls are unchanged.

## Installation and verification

A source patch alone cannot change an already compiled `.node` addon. The
postinstall hook therefore applies patches with `--error-on-fail`, then runs
`npm rebuild @2060.io/ffi-napi --build-from-source`. A failed patch or compilation
fails installation. Do not skip lifecycle scripts or force prebuilt-addon loading.
A compiler, make, Python and matching Node headers are required during the build;
the repository's full Node builder image supplies the toolchain. The final slim
image receives the compiled addon from that builder.

Run `yarn test --runInBand src/storage/__tests__/nativeCallbackLifecycle.spec.ts`.
The parent requires a valid completion report **and a normal child exit**. Its
outer timeout catches a hang even after a success report was printed. The test
uses temporary SQLite data and never opens configured application databases.

The PostgreSQL matrix can be repeated with:

```sh
node scripts/benchmark-single-record-query-suite.mjs > measurements.json
```

First create and seed the dedicated localhost fixture using the
[benchmark instructions](single-record-query-bound.md#local-postgresql-benchmark).
Use Node 22.22.2 to match the Dockerfile and install dependencies under that same
runtime. The runner executes children sequentially, alternates mode order,
retains failed outcomes, and returns nonzero if any child fails. Both comparison
modes include the callback race correction; only the query bound and result-list
release differ. No successful JSON report is accepted from a nonzero or timed-out
child process.
