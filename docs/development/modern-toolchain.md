# Modern JavaScript Toolchain

GlyphQuire uses the OXC toolchain as its primary JavaScript/TypeScript quality gate:

- `pnpm lint` runs Oxlint with the TypeScript and Vue plugins. `pnpm lint:fix` applies safe Oxlint fixes.
- `pnpm format` and `pnpm format:check` use Oxfmt for source, Vue, and JSON files.
- Markdown documentation remains an explicit Prettier fallback (`format:fallback:check`) because Oxfmt does not yet cover every Markdown construct used by the repository. Migration fixtures and generated Drizzle metadata remain ignored.
- `pnpm lint:compat` retains the previous ESLint configuration for diagnosing compatibility-only rules; it is not part of the CI gate.

Vite is pinned to the Vite 8 line, whose production bundler is Rolldown and whose transforms use Oxc. The existing Vue and Tailwind plugins remain on their Vite 8-compatible releases. Node.js `22.12.0` or newer is required.
