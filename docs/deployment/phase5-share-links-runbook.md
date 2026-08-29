# Phase 5 Share-Link Deployment and Incident Runbook

This runbook covers the Task 6 share-link schema, API seams, and cleanup consumer. The Task 7
maintenance scheduler remains responsible for emitting the hourly expired-link scan.

## Security properties

- A share token is an unpadded base64url encoding of exactly 32 CSPRNG bytes. It is bearer
  authority and must be handled like a credential.
- `share_links` stores only a domain-separated HMAC-SHA-256 digest. The plaintext token appears
  only in the creator's response and in the authenticated AES-256-GCM idempotency response.
- The HMAC root key must be the canonical base64url encoding of at least 32 random bytes. Until a
  dedicated share-token key is introduced, pass the existing `IDEMPOTENCY_ENCRYPTION_KEY`; the
  service derives a share-specific HMAC subkey with the fixed
  `glyphquire:share-link-token-hmac-key:v1` domain.
- Creation and revocation require the current note owner and current workspace membership.
  Resolution rechecks the hash, expiry, revocation, note deletion, workspace scope, and creator
  membership on every request.
- Public resolution receives a resolver-only adapter. Do not inject the management service into
  the public route container.

Never print the root key, plaintext token, idempotency ciphertext, note Markdown, cookie, or full
shared URL. Reverse-proxy and platform access logs must redact the path segment after
`/api/v1/shared/` (or disable full-path logging for that route); application error logs record only
the route class and stable code.

## Ordered deployment

1. Take and verify the pre-deployment backup required by the Phase 5 destructive-change policy.
2. Give only the migration process `MIGRATION_DATABASE_URL`. Run `pnpm db:verify-baseline`, then
   `pnpm db:migrate`. A baseline hash/timestamp mismatch is a hard stop; never edit the journal to
   make it pass.
3. Verify migration `0009_phase5_share_links`, its snapshot, and the `share_links` indexes and
   foreign keys before activating API code.
4. Give API and worker processes only the runtime `DATABASE_URL`. They must retain DML access and
   must not receive DDL, migration-journal, sequence-reset, or role-escalation privileges.
5. Construct `IdempotencyStore` with `IDEMPOTENCY_ENCRYPTION_KEY` and the configured
   `IDEMPOTENCY_LEASE_SECONDS`. Construct `ShareLinkServiceImpl` with the same canonical root key,
   the external same-origin API URL, `SHARE_DELETE_GRACE_SECONDS=3600`, and a transaction-bound
   `PostgresJobDispatcher`.
6. In the Task 8 application wiring, preserve this order:

   - global security headers and exact CORS policy;
   - `/api/v1/*` trusted-proxy/client-IP extraction, request security, and limiter readiness;
   - `createSharedRoutes` with a resolver-only frozen adapter and the public per-IP limiter;
   - generic authenticated request context, authenticated mutation limiter, and personal-workspace
     provisioning;
   - `createShareLinkRoutes` with the management service.

   The anonymous route must be registered before generic authentication but after security,
   client-IP, and limiter readiness. A safe adapter is
   `Object.freeze({ resolve: (token) => service.resolve(token) })`.

7. Start the worker only after `createJobRegistry` binds `share.cleanup`. Task 7 later schedules
   `share.cleanup { workspaceId, scope: "expired", batchSize: 1..100 }` hourly. Revocation already
   enqueues the targeted `scope: "one"` job for the exact grace boundary.

## Cleanup semantics

Revocation and expiry deny reads immediately. Physical deletion is eligible only when the current
row still satisfies this predicate at deletion time:

```sql
(revoked_at IS NOT NULL AND revoked_at <= now - SHARE_DELETE_GRACE_SECONDS)
OR
(revoked_at IS NULL AND expires_at <= now - SHARE_DELETE_GRACE_SECONDS)
```

The handler processes at most 100 rows in stable `(created_at, id)` order and emits at most one
typed continuation cursor. Re-delivery is idempotent. A workspace mismatch is `JOB_INVALID`; a
database or enqueue failure is the scrubbed `JOB_FAILED`. Audit events contain only job id,
workspace UUID, link UUID, and `expired|revoked`, never token/hash/Markdown.

## Verification

Use loopback test-role URLs and an isolated database for PostgreSQL suites:

```bash
pnpm --filter @glyphquire/database test -- src/migrations/phase5-share-links.integration.test.ts
pnpm --filter @glyphquire/api test:integration -- src/modules/share-links/ShareLinkService.integration.test.ts
pnpm --filter @glyphquire/api test:integration -- src/routes/v1/share-links.integration.test.ts
pnpm --filter @glyphquire/api test:integration -- src/routes/shared.integration.test.ts
pnpm --filter @glyphquire/worker test -- src/handlers/share-cleanup.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

Confirm creation returns one 43-character token, replay returns the identical encrypted response,
the table has only a 64-hex-character digest, and malformed/expired/revoked/deleted/inaccessible
requests all produce the same `SHARE_NOT_FOUND` 404. Confirm proxy and application logs contain no
test token before enabling external traffic.

## Incident response and rollback

- For one leaked URL, an authorized current note owner calls `DELETE /api/v1/share-links/:id`.
  Confirm the next public request is 404; physical cleanup may wait exactly 3600 seconds.
- For suspected root-key compromise, disable share creation, rotate the secret through secret
  management, restart API instances, and treat all prior links as invalid. Rotation also makes old
  encrypted idempotency responses unreadable, so coordinate it as a credential incident rather
  than a routine deploy.
- Inspect retry/DLQ state by stable job id and error code only. Never copy a public URL into a
  ticket, metric label, trace attribute, or replay command.
- Migration `0009` is forward-only. On activation failure, stop the new API/worker version and
  redeploy the previous binaries while retaining the compatible table. Do not drop the table or
  rewrite journal rows. If database recovery is required, use the verified pre-deployment backup
  and follow the main restore runbook.
