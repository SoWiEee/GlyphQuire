<template>
  <div class="readme-demo">
    <main class="readme-demo__main">
      <header class="readme-demo__masthead">
        <div class="readme-demo__brandline">
          <span class="readme-demo__wordmark">GlyphQuire / field notes</span>
          <span class="readme-demo__stamp">Local demo · desktop canvas</span>
        </div>
        <div class="readme-demo__heading">
          <div>
            <p class="readme-demo__eyebrow">A portable writing instrument</p>
            <h1>{{ title }}</h1>
            <p class="readme-demo__lede">
              A quiet tour through the workbench, semantic blocks, workspace tools, and sharing.
            </p>
          </div>
          <dl class="readme-demo__meta">
            <div>
              <dt>Document</dt>
              <dd>Markdown first</dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>Paper Canvas</dd>
            </div>
          </dl>
        </div>
      </header>

      <section v-if="scene === 'modes'" class="readme-scene readme-scene--wide">
        <div class="readme-scene__intro">
          <span class="readme-scene__index" aria-hidden="true">01</span>
          <div>
            <p class="readme-demo__eyebrow">Workbench</p>
            <h2>A calm place to write</h2>
            <p>
              Move between Source, Visual, and Split modes while one canonical document stays in
              control.
            </p>
          </div>
          <span class="readme-scene__note">Source ↔ Visual ↔ Split</span>
        </div>
        <div class="readme-workbench-frame">
          <Workbench
            :initial-notes="demoNotes"
            :session-factory="demoSessionFactory"
            :workspace-id="WORKSPACE_ID"
            :note-id="NOTE_ID"
          />
        </div>
      </section>

      <section v-else-if="scene === 'semantic'" class="readme-scene">
        <div class="readme-scene__intro">
          <span class="readme-scene__index" aria-hidden="true">02</span>
          <div>
            <p class="readme-demo__eyebrow">Semantic blocks</p>
            <h2>Structure without noise</h2>
            <p>
              Content keeps its Markdown shape while the visual editor gives it a readable form.
            </p>
          </div>
          <span class="readme-scene__note">Portable by default</span>
        </div>
        <div class="readme-semantic-layout">
          <aside class="readme-field-note" aria-label="Semantic block notes">
            <p class="readme-field-note__label">Field note</p>
            <p>Each block adds one clear affordance to the page, then gets out of the way.</p>
            <ol>
              <li><span>01</span> Callouts for emphasis</li>
              <li><span>02</span> Toggles for progressive detail</li>
              <li><span>03</span> Tabs and columns for comparison</li>
            </ol>
          </aside>
          <section
            data-testid="readme-semantic-editor"
            aria-label="Semantic editor"
            class="readme-semantic-editor"
          >
            <VisualEditor :markdown="semanticMarkdown" :read-only="true" />
          </section>
        </div>
      </section>

      <section v-else-if="scene === 'tools'" class="readme-scene">
        <div class="readme-scene__intro">
          <span class="readme-scene__index" aria-hidden="true">03</span>
          <div>
            <p class="readme-demo__eyebrow">Workspace tools</p>
            <h2>Useful when the work asks for it</h2>
            <p>Search, transfer, and maintenance tools stay close without taking over the page.</p>
          </div>
          <span class="readme-scene__note">Focused tools</span>
        </div>
        <div class="readme-tools-grid">
          <div class="readme-tool-surface">
            <p class="readme-tool-surface__label">Find a note</p>
            <SearchPalette :workspace-id="WORKSPACE_ID" @select-note="() => undefined" />
          </div>
          <div class="readme-tool-surface">
            <p class="readme-tool-surface__label">Move a document</p>
            <TransferDialog :workspace-id="WORKSPACE_ID" />
          </div>
        </div>
      </section>

      <section v-else class="readme-scene">
        <div class="readme-scene__intro">
          <span class="readme-scene__index" aria-hidden="true">04</span>
          <div>
            <p class="readme-demo__eyebrow">Sharing</p>
            <h2>Let the work travel lightly</h2>
            <p>A focused, read-only link gives someone the page they need and nothing more.</p>
          </div>
          <span class="readme-scene__note">Read-only by design</span>
        </div>
        <section aria-label="Share link" class="readme-share-note">
          <div class="readme-share-note__heading">
            <div>
              <p class="readme-field-note__label">Access note</p>
              <h2>Read-only sharing</h2>
            </div>
            <span class="readme-share-note__status">Protected</span>
          </div>
          <p>Share a focused note with a revocable, read-only link and a clear expiry.</p>
          <div class="readme-share-note__access">
            <span>Access</span>
            <strong>Anyone with the link can read</strong>
          </div>
          <button type="button" aria-label="Create share link">Create share link</button>
        </section>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import SearchPalette from "../components/search/SearchPalette.vue";
import TransferDialog from "../components/transfer/TransferDialog.vue";
import VisualEditor from "../components/visual/VisualEditor.vue";
import Workbench from "../components/workbench/Workbench.vue";
import type { EditorSession, EditorSessionState } from "../editors/editor-session.types.js";
import type { WorkbenchNote } from "../components/workbench/types.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const scene = computed(() => new URLSearchParams(window.location.search).get("scene"));
const title = computed(() =>
  scene.value === "modes"
    ? "Editor modes"
    : scene.value === "semantic"
      ? "Semantic blocks"
      : scene.value === "tools"
        ? "Search and transfer"
        : "Sharing",
);
const semanticMarkdown = `---
glyphquire-spec: 1
---

:::callout{type="info" title="A focused writing space"}
Keep intent visible without losing Markdown portability.
:::

::::toggle{title="Toggle supporting notes" open="true"}
Details stay close to the paragraph they explain.
::::

::::tabs

:::tab{title="Overview"}
Structured notes remain readable.
:::

:::tab{title="Examples"}
Canonical Markdown stays portable.
:::

::::

::::columns{count="2"}

:::column
Source remains inspectable.
:::

:::column
Visual blocks stay easy to scan.
:::

::::
`;

const demoNotes: readonly WorkbenchNote[] = [
  {
    id: NOTE_ID,
    title: "Project notebook",
    markdown:
      "Welcome to your notebook.\nCapture ideas, shape structured notes, and keep every edit portable.",
  },
];

const demoSessionFactory = async (): Promise<EditorSession> => {
  let current: EditorSessionState = {
    noteId: NOTE_ID,
    markdown: demoNotes[0]?.markdown ?? "",
    baseRevision: 2,
    dirty: false,
    saveStatus: "clean",
    conflict: null,
    mode: "source",
    activePane: "source",
    diagnostics: [],
    readOnly: false,
    isReadOnly: false,
    draftDurability: "persisted",
    draftDurabilityError: null,
    autosave: {
      status: "clean",
      revision: 2,
      lastSavedAt: "2026-08-30T00:00:00.000Z",
      lastError: null,
      conflict: null,
      pending: null,
    },
  };
  const listeners = new Set<(state: EditorSessionState) => void>();
  const notify = () => listeners.forEach((listener) => listener(current));
  return {
    snapshot: () => current,
    edit(markdown) {
      current = { ...current, markdown, dirty: true, saveStatus: "dirty" };
      notify();
    },
    async switchMode(mode) {
      current = { ...current, mode, activePane: mode === "visual" ? "visual" : "source" };
      notify();
      return { success: true, mode };
    },
    async attachModeAdapters() {
      return () => undefined;
    },
    async saveNow() {
      current = { ...current, dirty: false, saveStatus: "saved" };
      notify();
    },
    async requestTakeover() {
      return false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      listeners.clear();
    },
  };
};
</script>

<style scoped>
:global(html),
:global(body) {
  overflow-x: clip;
}

.readme-demo {
  min-height: 100vh;
  overflow-x: clip;
  background: var(--gq-canvas);
  color: var(--gq-color-foreground);
  font-family: var(--gq-typography-body-font);
}

.readme-demo__main {
  width: min(100% - 3rem, 78rem);
  margin: 0 auto;
  padding: clamp(1.5rem, 4vw, 4rem) 0 5rem;
}

.readme-demo__masthead {
  border-bottom: 1px solid var(--gq-color-border);
  padding-bottom: clamp(1.5rem, 3vw, 2.5rem);
}

.readme-demo__brandline,
.readme-demo__heading,
.readme-scene__intro,
.readme-share-note__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gq-spacing-lg);
}

.readme-demo__brandline {
  align-items: center;
  color: var(--gq-color-muted);
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.readme-demo__wordmark {
  color: var(--gq-color-foreground);
  font-weight: 700;
}

.readme-demo__stamp {
  white-space: nowrap;
}

.readme-demo__heading {
  align-items: flex-end;
  padding-top: clamp(2.5rem, 7vw, 6rem);
}

.readme-demo__eyebrow,
.readme-field-note__label,
.readme-tool-surface__label {
  margin: 0 0 var(--gq-spacing-sm);
  color: var(--gq-color-accent);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.readme-demo h1,
.readme-demo h2 {
  margin: 0;
  font-family: var(--gq-typography-heading-font);
  font-style: normal;
  font-weight: 500;
  letter-spacing: -0.025em;
}

.readme-demo h1 {
  max-width: 14ch;
  font-size: clamp(2.75rem, 7vw, 5.5rem);
  line-height: 0.98;
  overflow-wrap: anywhere;
}

.readme-demo h2 {
  font-size: clamp(1.8rem, 3vw, 2.7rem);
  line-height: 1.05;
}

.readme-demo__lede {
  max-width: 38rem;
  margin: var(--gq-spacing-md) 0 0;
  color: var(--gq-color-muted);
  font-size: 1rem;
  line-height: 1.7;
}

.readme-demo__meta {
  display: grid;
  min-width: 12rem;
  margin: 0;
  border-top: 1px solid var(--gq-color-border);
}

.readme-demo__meta div {
  display: flex;
  justify-content: space-between;
  gap: var(--gq-spacing-md);
  border-bottom: 1px solid var(--gq-color-border);
  padding: var(--gq-spacing-sm) 0;
}

.readme-demo__meta dt,
.readme-demo__meta dd {
  margin: 0;
  font-size: 0.75rem;
}

.readme-demo__meta dt {
  color: var(--gq-color-muted);
}

.readme-demo__meta dd {
  color: var(--gq-color-foreground);
  font-weight: 600;
  text-align: right;
}

.readme-scene {
  padding-top: clamp(3rem, 7vw, 6rem);
}

.readme-scene__intro {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: end;
  margin-bottom: var(--gq-spacing-xl);
}

.readme-scene__index {
  align-self: start;
  border-top: 2px solid var(--gq-color-accent);
  padding-top: var(--gq-spacing-xs);
  color: var(--gq-color-accent);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.readme-scene__intro p:not(.readme-demo__eyebrow) {
  max-width: 42rem;
  margin: var(--gq-spacing-sm) 0 0;
  color: var(--gq-color-muted);
  line-height: 1.7;
}

.readme-scene__note {
  align-self: end;
  color: var(--gq-color-muted);
  font-size: 0.75rem;
  white-space: nowrap;
}

.readme-workbench-frame,
.readme-semantic-editor,
.readme-tool-surface,
.readme-share-note {
  border: 1px solid var(--gq-color-border);
  background: var(--gq-surface);
}

.readme-workbench-frame {
  height: 650px;
  overflow: hidden;
  box-shadow: 0 18px 40px -28px color-mix(in srgb, var(--gq-color-foreground) 45%, transparent);
}

.readme-semantic-layout {
  display: grid;
  grid-template-columns: minmax(12rem, 0.7fr) minmax(0, 1.3fr);
  gap: clamp(1.5rem, 5vw, 4rem);
  align-items: start;
}

.readme-field-note {
  border-top: 1px solid var(--gq-color-border);
  padding-top: var(--gq-spacing-md);
  color: var(--gq-color-muted);
}

.readme-field-note > p:not(.readme-field-note__label) {
  max-width: 20rem;
  margin: 0;
  line-height: 1.7;
}

.readme-field-note ol {
  display: grid;
  gap: var(--gq-spacing-md);
  margin: var(--gq-spacing-xl) 0 0;
  padding: 0;
  list-style: none;
  font-size: 0.85rem;
}

.readme-field-note li {
  display: flex;
  gap: var(--gq-spacing-sm);
  align-items: baseline;
}

.readme-field-note li span {
  color: var(--gq-color-accent);
  font-variant-numeric: tabular-nums;
}

.readme-semantic-editor {
  min-width: 0;
  padding: clamp(1rem, 3vw, 2rem);
}

.readme-semantic-editor :deep([data-glyphquire-node] > header) {
  display: none;
}

.readme-semantic-editor :deep([data-glyphquire-node="callout"]),
.readme-semantic-editor :deep([data-glyphquire-node="toggle"]),
.readme-semantic-editor :deep([data-glyphquire-node="tabs"]),
.readme-semantic-editor :deep([data-glyphquire-node="columns"]) {
  border-color: var(--gq-color-border);
  background: color-mix(in srgb, var(--gq-surface) 86%, var(--gq-color-background));
  color: var(--gq-color-foreground);
}

.readme-semantic-editor :deep([data-glyphquire-node="columns"]) {
  gap: var(--gq-spacing-md);
}

.readme-semantic-editor :deep([data-glyphquire-node="column"]) {
  border: 1px solid var(--gq-color-border);
  background: var(--gq-surface);
}

.readme-tools-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gq-spacing-lg);
}

.readme-tool-surface {
  min-width: 0;
  padding: var(--gq-spacing-lg);
}

.readme-tool-surface__label {
  border-bottom: 1px solid var(--gq-color-border);
  padding-bottom: var(--gq-spacing-sm);
}

.readme-share-note {
  max-width: 48rem;
  padding: clamp(1.25rem, 4vw, 2.5rem);
}

.readme-share-note__heading {
  align-items: center;
  margin-bottom: var(--gq-spacing-lg);
}

.readme-share-note h2 {
  font-size: clamp(1.8rem, 4vw, 3rem);
}

.readme-share-note > p {
  max-width: 34rem;
  margin: 0;
  color: var(--gq-color-muted);
  line-height: 1.7;
}

.readme-share-note__status {
  border: 1px solid color-mix(in srgb, var(--gq-color-success) 45%, var(--gq-color-border));
  padding: var(--gq-spacing-xs) var(--gq-spacing-sm);
  color: var(--gq-color-success);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

.readme-share-note__access {
  display: grid;
  gap: var(--gq-spacing-xs);
  margin: var(--gq-spacing-xl) 0;
  border-left: 2px solid var(--gq-color-accent);
  padding-left: var(--gq-spacing-md);
}

.readme-share-note__access span {
  color: var(--gq-color-muted);
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.readme-share-note__access strong {
  font-size: 0.95rem;
}

.readme-share-note button {
  border: 1px solid var(--gq-color-accent);
  background: var(--gq-color-accent);
  color: var(--gq-color-accent-contrast);
  cursor: pointer;
  padding: var(--gq-spacing-sm) var(--gq-spacing-md);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 700;
}

.readme-share-note button:hover {
  background: color-mix(in srgb, var(--gq-color-accent) 86%, var(--gq-color-foreground));
}

.readme-share-note button:focus-visible {
  outline: 2px solid var(--gq-color-accent);
  outline-offset: 3px;
  box-shadow: var(--gq-focus-ring);
}

@media (max-width: 48rem) {
  .readme-demo__main {
    width: min(100% - 2rem, 78rem);
  }

  .readme-demo__heading,
  .readme-scene__intro,
  .readme-semantic-layout {
    grid-template-columns: 1fr;
  }

  .readme-demo__heading {
    align-items: start;
    flex-direction: column;
  }

  .readme-demo__meta {
    width: 100%;
  }

  .readme-scene__intro {
    gap: var(--gq-spacing-md);
  }

  .readme-scene__note {
    justify-self: start;
  }

  .readme-share-note__heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .readme-tools-grid {
    grid-template-columns: 1fr;
  }

  .readme-workbench-frame {
    height: 560px;
  }
}

@media (max-width: 30rem) {
  .readme-demo__brandline {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--gq-spacing-xs);
  }

  .readme-demo h1 {
    font-size: clamp(2.5rem, 16vw, 4rem);
  }
}
</style>
