# Phase 5 backup and restore drill evidence

This append-only log records restore-drill outcomes. It contains only scrubbed
identifiers, row counts, authenticated-artifact checksums, and aggregate object
hashes; document Markdown bodies, database URLs, encryption keys, object names,
and provider credentials are intentionally excluded.

- Evidence is appended by `infra/backup/phase5-restore-drill.sh`.
- Backup envelopes use authenticated AES-256-GCM with a versioned key and
  ciphertext/plaintext checksums. The retention cutoff is 30 days.
- The drill validates the frozen forward-only migration journal, schema version,
  note/version/asset row and relationship invariants, and canonical Markdown
  hashes without rewriting canonical source during rollback verification.
- The drill always uses separately configured database and object-storage
  targets. Destructive target cleanup requires `RESTORE_CONFIRMATION=isolated`.
- Temporary key material and decrypted dumps are confined to a `mktemp` work
  directory and removed on both success and failure.
- A failed attempt remains a scrubbed event; a retry with the same complete
  backup is idempotent and never overwrites the immutable backup envelope.
