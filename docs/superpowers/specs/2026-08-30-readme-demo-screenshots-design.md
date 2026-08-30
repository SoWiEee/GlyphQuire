# README Demo Screenshots Design

## Goal

Add a compact four-panel visual introduction to README.md so a new reader can
understand GlyphQuire's main workflows without running the project first.

## Four panels

1. **Dual-mode editing** — the Workbench showing Visual and Source mode affordances,
   with canonical Markdown and a visible save/revision state.
2. **Semantic Markdown blocks** — a rendered note containing a callout, toggle,
   tabs, and columns, using the built-in theme rather than raw HTML.
3. **Search and transfer** — a search result plus the import/export dialog in a
   deterministic workspace fixture, showing logical asset references only.
4. **Sharing and maintenance** — the read-only share flow and capability-gated
   maintenance surface, with sanitized status text and no secrets or document
   bodies exposed.

## Capture and storage

Capture the scenes with the repository's Playwright Chrome setup against a
deterministic local fixture. Route external API calls to fixed, sanitized
responses; do not use real accounts, cookies, object-store URLs, tokens, or
provider diagnostics. Use a 1440×900 viewport and stable data attributes where
needed. Store the resulting PNGs at:

```text
docs/assets/readme/01-editor-modes.png
docs/assets/readme/02-semantic-blocks.png
docs/assets/readme/03-search-transfer.png
docs/assets/readme/04-sharing-maintenance.png
```

README.md will add one HTML table immediately after “What is GlyphQuire”. Each
cell contains one image, a short caption, and no remote image URL. A note below
the table states that the images are deterministic local-demo captures.

## Acceptance

- All four files exist and render as non-empty PNGs.
- Captures contain no secrets, personal data, bearer tokens, presigned URLs,
  raw Markdown payloads, or provider error details.
- The table renders acceptably on GitHub at desktop and narrow widths.
- The capture test is reproducible with one documented command and fails if a
  required scene or accessibility label disappears.
