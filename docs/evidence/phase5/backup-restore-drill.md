# Phase 5 backup and restore drill evidence

This append-only log records restore-drill outcomes. It contains identifiers,
relationship counts, and aggregate object hashes only; document Markdown bodies,
database URLs, encryption keys, and object credentials are intentionally excluded.

- Evidence is appended by `infra/backup/phase5-restore-drill.sh`.
- Backups are encrypted with AES-256 and retained for 30 days.
- The drill always uses a separately configured database and object-storage target.
