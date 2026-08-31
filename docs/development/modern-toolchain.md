# Modern JavaScript Toolchain

GlyphQuire uses the OXC toolchain as its primary JavaScript/TypeScript quality gate:

- `pnpm lint` runs Oxlint with the TypeScript and Vue plugins. `pnpm lint:fix` applies safe Oxlint fixes.
- `pnpm format` and `pnpm format:check` use Oxfmt for source, Vue, and JSON files.
- Oxfmt is the sole formatter for repository-owned source and documentation. Migration fixtures, generated Drizzle metadata, and `.superpowers/**` process artifacts remain ignored by the Oxfmt configuration.
- Oxlint is the sole linter; the repository has no secondary compatibility linter or formatter.

Vite is pinned to the Vite 8 line, whose production bundler is Rolldown and whose transforms use Oxc. The existing Vue and Tailwind plugins remain on their Vite 8-compatible releases. Node.js `22.12.0` or newer is required.
