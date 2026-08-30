# Phase 5 security compliance matrix

This is an engineering evidence map, not a certification. Unexecuted manual or
external checks remain release blockers.

| Control area                                 | Applicability | Repository evidence                                                                          | Current result                                                |
| -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Authentication and tenant authorization      | Required      | Route/service integration tests; workspace and response-identity checks                      | Automated focused coverage present; full-stack denial pending |
| Request/response validation                  | Required      | Shared strict Zod contracts and `Phase5Client.test.ts`                                       | Focused coverage present                                      |
| File upload allowlist and size limit         | Required      | Asset/import contracts, multipart route tests, passive-image resolver tests                  | Focused coverage present; MinIO full-stack pending            |
| Filename/path and ZIP traversal safety       | Required      | Server-generated object keys and import handler traversal regressions                        | Automated coverage present; Chrome full-stack pending         |
| Content type, size, and SHA-256 verification | Required      | Asset service/storage integration tests and resolver byte bound                              | Automated coverage present; production object store pending   |
| Stored/DOM injection                         | Required      | Inert visual schema, blob-only asset resolver, escaped Vue rendering, axe/E2E hostile values | Focused coverage present                                      |
| CSRF and same-origin browser API             | Required      | Root-relative client, same-origin credentials, request security middleware                   | Focused coverage present                                      |
| Secrets and document-content logging         | Required      | Stable public errors; token-memory-only store; sanitized alert/load harnesses                | Manual production-log review pending                          |
| Opaque share tokens and revocation           | Required      | Hash-only service tests and deterministic revoke/404 browser flow                            | Focused coverage present; full-stack pending                  |
| Job retry/dead-letter isolation              | Required      | Generic queue tests, freshness no-DLQ assertion, operator diagnostics                        | PostgreSQL freshness run pending                              |
| Backup encryption and deletion lifecycle     | Required      | Backup/restore/deletion integration artifacts                                                | External restore/deletion evidence pending                    |
| Dependency/build provenance                  | Required      | Frozen lockfile and release gate                                                             | Frozen offline install/SBOM review pending                    |

No browser code accepts an API origin or bearer token. Asset rendering accepts
only canonical `asset://<uuid>` input, authorizes metadata against the active
workspace, allows passive raster MIME types, reads a bounded declared byte
count, and exposes only an owned `blob:` URL to the DOM. Anonymous share routes
remain subject to public security headers and rate limits before authenticated
personal-workspace middleware.
