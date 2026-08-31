# Phase 5 performance and load evidence

Required profile: five actors for 30 minutes, one 100 KiB note each, autosave
every two seconds, search every ten seconds, and one 5 MiB raster upload every
five minutes. After a two-minute warm-up, `GET note`, `PUT autosave`, and
`GET search` each require at least 500 samples. Gates are p95 below 500 ms,
1,000 ms, and 500 ms respectively, with no timeout, unexpected 5xx, integrity
failure, revision regression, new dead letter, or search lag beyond 60 seconds.

The deterministic runner is `tests/load/phase5-product-services.ts`, exposed as:

```sh
pnpm test:load:phase5 -- --duration=30m --users=5
```

It strictly validates actor configuration and API responses, uses same-origin
session cookies from environment only, reads every acknowledged revision back
and verifies its in-memory hash, tracks per-route p50/p95/p99, checks operator
dead-letter diagnostics before/after, and never prints IDs, cookies, Markdown,
hashes, or response bodies. Shorter durations are labelled `SMOKE_ONLY` and
cannot satisfy P0.

Execution on 2026-08-30: a one-second/one-user invocation reached the harness
and exited 2 with the fixed `PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER` result because
the three required environment inputs were absent. The production profile was
**not run**. No five-user API/PostgreSQL/MinIO load environment or seeded actor
credentials were supplied. Therefore p50/p95/p99,
sample counts, image digest, 4-vCPU/8-GB host details, data volume, queue drain,
and error budget are absent. **This is a release blocker.**

Phase 6 keeps this runner as the API burst harness. The release profile must
first create a measured host manifest and pass it explicitly:

```sh
pnpm test:load:phase6-environment
pnpm test:load:phase5 -- --duration=30m --users=5 \
  --environment-manifest=docs/evidence/phase6/performance-environment.json
```

The runner rejects self-declared resource values, validates the manifest
identity/hash, and writes the sanitized result to
`docs/evidence/phase6/performance-load.json`.
