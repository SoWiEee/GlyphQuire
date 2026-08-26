# Phase 4 — Interactive Runtime Design Spec

**Goal:** Deliver a secure, isolated sandbox for executing user-authored p5.js and Canvas code blocks inside GlyphQuire notes, with a versioned postMessage protocol, strict CSP, resource controls, and comprehensive security tests.

**Architecture:** A separate-origin static app (`apps/sandbox`) communicates with the host (`apps/web`) exclusively through a typed postMessage protocol defined in `packages/runtime-protocol`. The sandbox runs user code in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`), enforcing full origin isolation. p5.js is bundled inside the sandbox — no external CDN dependencies.

**Tech Stack:** Vite (sandbox static build), Vue 3.5+ (host components), TypeScript strict, Zod (message validation), p5.js (bundled), Playwright (E2E + security tests).

**Spec:** `docs/SPEC.md` §14 (Interactive Runtime), §12 (Plugin Manifest — runtime permissions), §34.2 (Local origin layout).

## Global Constraints

- Node.js 22+, pnpm 9+, TypeScript strict mode.
- `packages/runtime-protocol` is pure TypeScript + Zod — zero DOM or Node runtime dependencies.
- `apps/sandbox` must never import from `apps/web`, `apps/api`, or any server-side package.
- Sandbox and host must be different origins (SPEC §14.1). Local: `http://localhost:5174` (sandbox) vs `http://localhost:5173` (host). Production: separate domain (e.g. `sandbox.exampleusercontent.com`).
- `<iframe sandbox="allow-scripts">` — never add `allow-same-origin` (SPEC §14.2).
- Network default-deny in sandbox (SPEC §14.5): CSP `connect-src 'none'`. Allowlist is reserved for future protocol extension; v1 is fully offline.
- `postMessage` calls must always specify the target origin — never `"*"` (SPEC §14.3).
- Existing `RuntimeNode` AST type and `p5Block`/`canvasBlock` definitions in `packages/document-engine` are consumed as-is; this phase does not modify them.
- kebab-case for package directories, camelCase for functions/variables, PascalCase for types/components.

---

## 1. Package Architecture

### 1.1 `packages/runtime-protocol`

Shared message types and validation between host and sandbox. Zero runtime dependencies beyond Zod.

```
packages/runtime-protocol/
  src/
    messages.ts          # RuntimeMessage union type + Zod schemas
    constants.ts         # Resource limit constants
    index.ts             # Public exports
  tests/
    messages.test.ts
    constants.test.ts
  tsconfig.json
  package.json
  vitest.config.ts
```

**Exports:**

- `HostMessage` — union of messages host sends to sandbox
- `SandboxMessage` — union of messages sandbox sends to host
- `hostMessageSchema` — Zod schema for validating host→sandbox messages
- `sandboxMessageSchema` — Zod schema for validating sandbox→host messages
- `parseHostMessage(data: unknown): HostMessage | null` — safe parse, returns null on invalid
- `parseSandboxMessage(data: unknown): SandboxMessage | null`
- Constants: `MAX_CODE_SIZE_BYTES`, `MAX_IFRAMES_PER_PAGE`, `MAX_MESSAGE_RATE`, `EXECUTION_TIMEOUT_MS`, `PROTOCOL_VERSION`

### 1.2 `apps/sandbox`

Minimal Vite static app. Produces `index.html` + bundled JS (including p5.js).

```
apps/sandbox/
  src/
    main.ts              # Entry: message listener, origin validation, dispatch
    protocol.ts          # Message send/receive helpers with origin check
    runners/
      p5-runner.ts       # p5.js instance-mode execution
      canvas-runner.ts   # Canvas 2D bootstrap context
    resource-guard.ts    # Timeout watchdog, cleanup
  public/
    index.html           # Minimal shell: <div id="runtime-root">
  vite.config.ts
  package.json
  tsconfig.json
```

### 1.3 `apps/web` additions

```
apps/web/src/
  runtime/
    RuntimeHost.vue        # iframe manager + UI controls
    useRuntimeBridge.ts    # Composable: postMessage lifecycle + state machine
    runtime-config.ts      # Sandbox origin from VITE_SANDBOX_ORIGIN env
  editors/visual/nodes/
    runtime.ts             # Milkdown node view for RuntimeNode
```

---

## 2. Runtime Protocol

### 2.1 Message Types

All messages carry `v: 1` (protocol version) and `id` (runtime instance UUID).

**Host → Sandbox:**

| Type              | Payload                                         | Purpose                                                                             |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `runtime:init`    | `{ runtime: "p5" \| "canvas"; origin: string }` | Initialize sandbox for a specific runtime type; `origin` is the allowed host origin |
| `runtime:execute` | `{ source: string; props: RuntimeProps }`       | Execute user code with parsed props (height, network, autoplay)                     |
| `runtime:stop`    | —                                               | Stop execution immediately                                                          |

**Sandbox → Host:**

| Type              | Payload                              | Purpose                                                |
| ----------------- | ------------------------------------ | ------------------------------------------------------ |
| `runtime:ready`   | —                                    | Sandbox initialized and ready to receive code          |
| `runtime:resize`  | `{ height: number }`                 | Request iframe height change (canvas auto-size)        |
| `runtime:error`   | `{ message: string; line?: number }` | Runtime error (syntax, runtime, or timeout)            |
| `runtime:stopped` | —                                    | Execution stopped (ack for stop, or timeout self-stop) |

### 2.2 Validation Rules (per SPEC §14.3)

Every message receiver (both sides) must:

1. **Verify `event.origin`** — host checks against sandbox origin; sandbox checks against the `origin` received in `runtime:init`.
2. **Validate message schema** — Zod `safeParse`; invalid messages silently dropped.
3. **Verify runtime instance `id`** — must match the active runtime session; stale IDs dropped.
4. **Reject unknown message types** — only defined types are processed.
5. **Rate-limit** — host enforces max 60 messages/second from sandbox using a sliding-window counter. Exceeding the limit triggers `runtime:stop`.

### 2.3 Lifecycle

```
Host                              Sandbox
  │                                  │
  │─── create iframe ──────────────►│
  │                                  │ (loads index.html)
  │◄─── (iframe load event) ────────│
  │                                  │
  │─── runtime:init ───────────────►│
  │                                  │ (load runner, validate origin)
  │◄─── runtime:ready ──────────────│
  │                                  │
  │─── runtime:execute ────────────►│
  │                                  │ (run user code)
  │◄─── runtime:resize (0..n) ──────│
  │◄─── runtime:error (0..n) ───────│
  │                                  │
  │─── runtime:stop ───────────────►│
  │                                  │ (cleanup)
  │◄─── runtime:stopped ────────────│
```

---

## 3. Sandbox App

### 3.1 CSP

The sandbox `index.html` sets the following Content-Security-Policy via `<meta>` tag:

```
default-src 'none';
script-src 'self';
style-src 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'none';
frame-ancestors *;
```

- `connect-src 'none'` enforces SPEC §14.5 network default-deny.
- `script-src 'self'` — only the bundled JS executes; no inline scripts, no eval (p5.js does not require eval).
- `frame-ancestors *` — the sandbox is designed to be embedded.

### 3.2 Entry (`main.ts`)

1. Register `message` event listener on `window`.
2. On first valid `runtime:init`: store the allowed host origin and runtime type. Reject any further `runtime:init`.
3. Load the appropriate runner module (dynamic import for code splitting).
4. Send `runtime:ready`.
5. On `runtime:execute`: pass source + props to the runner. Start the resource guard timeout.
6. On `runtime:stop`: call runner's `stop()`, clear timeout, send `runtime:stopped`.

### 3.3 p5 Runner

- p5.js is bundled as a dependency of `apps/sandbox` (imported from `node_modules`).
- Uses **p5 instance mode**: `new p5((sketch) => { ... }, containerElement)`.
- User code is wrapped in a `new Function('sketch', userSource)` call, passing the p5 instance as `sketch`.
- The runner exposes `setup`, `draw`, `mousePressed`, `keyPressed`, and other standard p5 lifecycle hooks.
- `stop()` calls `sketch.remove()` and clears the container.

### 3.4 Canvas Runner

- Creates a `<canvas>` element in the runtime root container.
- Gets 2D rendering context.
- User code is wrapped in `new Function('canvas', 'ctx', 'width', 'height', userSource)`.
- Provides `requestAnimationFrame` loop if user code exports a `draw` function.
- `stop()` cancels the animation frame and clears the canvas.

### 3.5 Resource Guard

- Starts a `setTimeout(EXECUTION_TIMEOUT_MS)` when `runtime:execute` is received.
- On timeout: calls runner `stop()`, sends `runtime:error` with timeout message, sends `runtime:stopped`.
- Listens for uncaught errors via `window.onerror` and `window.onunhandledrejection` — forwards as `runtime:error`.
- Cleanup on `runtime:stop`: clears timeout, removes error handlers.

---

## 4. Host Integration

### 4.1 `runtime-config.ts`

```ts
export const SANDBOX_ORIGIN = import.meta.env.VITE_SANDBOX_ORIGIN ?? "http://localhost:5174";
```

Added to `.env.example`:

```
VITE_SANDBOX_ORIGIN=http://localhost:5174
```

### 4.2 `useRuntimeBridge` Composable

**State machine:**

```
idle → initializing → ready → executing → stopped
                                  ↓
                                error
```

**Interface:**

```ts
interface RuntimeBridge {
  state: Ref<"idle" | "initializing" | "ready" | "executing" | "stopped" | "error">;
  error: Ref<{ message: string; line?: number } | null>;
  execute(source: string, props: RuntimeProps): void;
  stop(): void;
  reset(): void;
  cleanup(): void;
}

function useRuntimeBridge(
  iframeRef: Ref<HTMLIFrameElement | null>,
  runtime: "p5" | "canvas",
): RuntimeBridge;
```

**Responsibilities:**

- On iframe load: send `runtime:init` with runtime type and `SANDBOX_ORIGIN`.
- Validate all incoming messages: `event.origin`, schema, instance `id`.
- Sliding-window rate limiter: track message timestamps in a circular buffer; if count exceeds `MAX_MESSAGE_RATE` in any 1-second window, send `runtime:stop` and transition to error state.
- On `runtime:resize`: update iframe height (clamped to 100–2000px).
- On `runtime:error`: store error, transition to error state.
- `cleanup()`: remove event listener, send `runtime:stop` if executing, nullify references.

### 4.3 `RuntimeHost.vue`

**Props:**

- `runtime: "p5" | "canvas"` (required)
- `source: string` (required)
- `height: number` (default 400)
- `autoplay: boolean` (default false)

**Rendering states:**

| State          | Display                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| idle / stopped | Placeholder: code preview (first 5 lines, syntax highlighted) + centered play button |
| initializing   | Placeholder + spinner overlay                                                        |
| ready          | Same as idle (auto-transitions to executing if autoplay)                             |
| executing      | Live iframe + stop button overlay (top-right)                                        |
| error          | Error panel: red border, error message, line number if available, reset button       |

**Max iframe limit:**

- Module-level reactive counter tracks active `RuntimeHost` instances with state `executing` or `initializing`.
- When counter reaches `MAX_IFRAMES_PER_PAGE` (8), additional instances show a disabled placeholder: "Maximum active runtimes reached. Stop another runtime to start this one."

**Code size check:**

- Before calling `bridge.execute()`, check `new TextEncoder().encode(source).byteLength <= MAX_CODE_SIZE_BYTES` (64KB).
- If exceeded, show error state with "Code exceeds maximum size (64KB)".

### 4.4 Milkdown Node View (`editors/visual/nodes/runtime.ts`)

- Defines `$nodeSchema` for `gq_runtime` ProseMirror node (maps to `RuntimeNode` AST).
- Defines `$view` that mounts `RuntimeHost.vue`.
- Node attributes: `runtime`, `source`, `height`, `autoplay`.
- Source editing: clicking the code preview opens an inline CodeMirror editor (JavaScript mode) within the node view. Changes update the ProseMirror node attribute.
- Exports `runtimePlugins: MilkdownPlugin[]`.

---

## 5. Resource Controls

All constants defined in `packages/runtime-protocol/src/constants.ts`:

```ts
export const PROTOCOL_VERSION = 1;
export const EXECUTION_TIMEOUT_MS = 30_000;
export const MAX_IFRAMES_PER_PAGE = 8;
export const MAX_MESSAGE_RATE = 60; // messages per second
export const MAX_CODE_SIZE_BYTES = 65_536; // 64KB
export const RESIZE_MIN_HEIGHT = 100;
export const RESIZE_MAX_HEIGHT = 2000;
```

| Control              | Location                    | Mechanism                                                                                     |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| Execution timeout    | Sandbox `resource-guard.ts` | `setTimeout(EXECUTION_TIMEOUT_MS)` — auto-stop + error                                        |
| Max iframes per page | Host `RuntimeHost.vue`      | Module-level reactive counter; blocks new executions at limit                                 |
| Message rate limit   | Host `useRuntimeBridge.ts`  | Sliding-window counter; exceeding sends `runtime:stop`                                        |
| Max code size        | Host `RuntimeHost.vue`      | `TextEncoder.encode().byteLength` check before execute                                        |
| Crash recovery       | Host `useRuntimeBridge.ts`  | iframe `error` event detection → transition to error state, offer reset (full iframe rebuild) |
| Resize bounds        | Host `useRuntimeBridge.ts`  | Clamp incoming height to `[RESIZE_MIN_HEIGHT, RESIZE_MAX_HEIGHT]`                             |

**Stop flow:** Host sends `runtime:stop` → Sandbox calls runner `stop()` (p5: `sketch.remove()`; canvas: `cancelAnimationFrame` + clear) → Sandbox sends `runtime:stopped` → Host transitions to stopped state.

**Reset flow:** Host destroys iframe element → creates new iframe → full init/ready/execute cycle. Required for p5 (global state cannot be cleanly reset).

**Timeout flow:** Sandbox's resource guard fires → calls runner `stop()` → sends `runtime:error` with `"Execution timed out after 30s"` → sends `runtime:stopped`.

---

## 6. Development Setup

### 6.1 Vite Config (`apps/sandbox/vite.config.ts`)

```ts
export default defineConfig({
  server: { port: 5174, strictPort: true },
  build: { outDir: "dist", target: "esnext" },
});
```

### 6.2 `pnpm dev`

The root `pnpm dev` (which runs `pnpm -r --parallel dev`) starts both `apps/web` (port 5173) and `apps/sandbox` (port 5174) in parallel. No reverse proxy needed for local development — different ports = different origins.

### 6.3 Docker Compose

A `sandbox` service is added to `docker-compose.yml`:

```yaml
sandbox:
  build:
    context: .
    dockerfile: apps/sandbox/Dockerfile
  ports:
    - "5174:80"
```

Production: Caddy reverse proxy routes `sandbox.localhost` to the sandbox service (per SPEC §34.2).

---

## 7. Testing

### 7.1 Unit Tests

**`packages/runtime-protocol/tests/`:**

- `messages.test.ts` — Zod schema validation: valid messages parse, invalid rejected, unknown types rejected, missing fields rejected, `v` must be 1.
- `constants.test.ts` — Constants are positive integers, `PROTOCOL_VERSION` is 1.

**`apps/sandbox/src/` (co-located tests):**

- `protocol.test.ts` — Origin validation accepts/rejects correctly, message sending specifies target origin.
- `runners/p5-runner.test.ts` — Execution produces canvas element, stop removes it, syntax error caught and reported.
- `runners/canvas-runner.test.ts` — Canvas created with correct dimensions, draw loop runs, stop cancels animation frame.
- `resource-guard.test.ts` — Timeout fires after configured duration, cleanup cancels timeout, uncaught errors forwarded.

**`apps/web/src/runtime/` (co-located tests):**

- `useRuntimeBridge.test.ts` — State machine transitions, origin validation rejects spoofed messages, rate limiter triggers stop at threshold, cleanup removes listener.
- `RuntimeHost.test.ts` — Renders placeholder when idle, shows error overlay on error state, respects max iframe limit, rejects oversized code.

### 7.2 E2E Tests (`tests/e2e/runtime.spec.ts`)

1. **p5 block play/stop cycle** — Insert p5 block, click play, verify canvas renders, click stop, verify stopped state.
2. **Canvas block execution** — Insert canvas block, execute, verify canvas visible.
3. **Timeout triggers error** — Execute infinite loop code, wait for timeout, verify error message displayed.
4. **Max iframe limit** — Create 9 runtime blocks, start 8, verify 9th shows limit message.
5. **Code size limit** — Attempt to execute >64KB source, verify error before execution.

### 7.3 Security Tests (`tests/e2e/runtime-security.spec.ts`)

Per SPEC acceptance criteria #21:

1. **Origin isolation** — Navigate to sandbox origin directly; verify it cannot access `document.cookie` from host origin, `localStorage` is independent, `sessionStorage` is independent.
2. **Network deny** — From sandbox, attempt `fetch("https://example.com")` → verify blocked by CSP.
3. **XHR deny** — From sandbox, attempt `new XMLHttpRequest()` GET → verify blocked.
4. **WebSocket deny** — From sandbox, attempt `new WebSocket()` → verify blocked.
5. **postMessage origin validation** — Send message from a third iframe with different origin to sandbox → verify sandbox ignores it.
6. **iframe sandbox attribute** — Verify the iframe element has `sandbox="allow-scripts"` and does NOT include `allow-same-origin`.
7. **Host cookie isolation** — Set a cookie on host origin, execute sandbox code that reads `document.cookie` → verify empty.

---

## 8. File Inventory

### New packages/apps

| Path                         | Type    | Purpose                                      |
| ---------------------------- | ------- | -------------------------------------------- |
| `packages/runtime-protocol/` | package | Shared message types, Zod schemas, constants |
| `apps/sandbox/`              | app     | Isolated runtime host (Vite static build)    |

### New files in existing packages

| Path                                           | Purpose                                 |
| ---------------------------------------------- | --------------------------------------- |
| `apps/web/src/runtime/RuntimeHost.vue`         | iframe manager + controls UI            |
| `apps/web/src/runtime/useRuntimeBridge.ts`     | postMessage composable                  |
| `apps/web/src/runtime/runtime-config.ts`       | Sandbox origin config                   |
| `apps/web/src/editors/visual/nodes/runtime.ts` | Milkdown node view for p5/canvas blocks |
| `tests/e2e/runtime.spec.ts`                    | E2E functional tests                    |
| `tests/e2e/runtime-security.spec.ts`           | E2E security tests                      |

### Modified files

| Path                                   | Change                                        |
| -------------------------------------- | --------------------------------------------- |
| `pnpm-workspace.yaml`                  | Already includes `apps/*` — no change needed  |
| `docker-compose.yml`                   | Add `sandbox` service                         |
| `.env.example`                         | Add `VITE_SANDBOX_ORIGIN`                     |
| `apps/web/package.json`                | Add `@glyphquire/runtime-protocol` dependency |
| `apps/web/src/editors/visual/index.ts` | Register `runtimePlugins`                     |

---

## 9. Security Summary

| Threat                                      | Mitigation                                                           |
| ------------------------------------------- | -------------------------------------------------------------------- |
| User code accesses host cookies/auth tokens | Separate origin + `sandbox="allow-scripts"` (no `allow-same-origin`) |
| User code exfiltrates data via network      | CSP `connect-src 'none'` blocks fetch/XHR/WebSocket                  |
| User code runs indefinitely                 | 30s execution timeout in sandbox resource guard                      |
| Message flood from sandbox                  | Host rate-limiter (60 msg/s) with auto-stop                          |
| Spoofed postMessage from third party        | Origin validation on every message (both sides)                      |
| Oversized code payload                      | 64KB size check before execute                                       |
| Too many concurrent runtimes                | Max 8 active iframes per page                                        |
| Sandbox code injects into host DOM          | iframe sandbox attribute prevents parent document access             |
| p5.js CDN supply chain attack               | p5.js bundled locally, `script-src 'self'` blocks external scripts   |

---

## 10. Out of Scope

- Network allowlist (`network=["..."]` attribute) — protocol reserves the field; v1 enforces full deny. Future extension only.
- Web Worker offloading for parser-heavy computation — documented in SPEC §14.6 as optional; not required for v1.
- Plugin marketplace runtime permissions beyond `runtime:p5` and `runtime:canvas`.
- Reverse proxy configuration for production (Caddy/nginx) — infrastructure concern, separate from application code.
- Sandbox service Dockerfile — minimal, can be added during deployment hardening (Phase 6).
