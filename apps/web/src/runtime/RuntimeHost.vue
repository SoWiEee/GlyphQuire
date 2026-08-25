<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from "vue";
import { useRuntimeBridge } from "./useRuntimeBridge.js";
import { SANDBOX_ORIGIN } from "./runtime-config.js";
import { MAX_IFRAMES_PER_PAGE, MAX_CODE_SIZE_BYTES } from "@glyphquire/runtime-protocol";

const props = withDefaults(
  defineProps<{
    runtime: "p5" | "canvas";
    source: string;
    height?: number;
    autoplay?: boolean;
  }>(),
  {
    height: 400,
    autoplay: false,
  },
);

// Tracks whether the iframe has been mounted at least once. The iframe must
// exist in the DOM (and finish loading) before `bridge.reset()` is called,
// because `reset()` posts the `runtime:init` message through
// `iframeRef.value.contentWindow` immediately.
const started = ref(false);
const activeCount = ref(0);
const iframeRef = ref<HTMLIFrameElement | null>(null);
const codeSizeError = ref<string | null>(null);
const bridge = useRuntimeBridge(iframeRef, props.runtime);

const isActive = computed(
  () => bridge.state.value === "executing" || bridge.state.value === "initializing",
);

const isAtLimit = computed(() => activeCount.value >= MAX_IFRAMES_PER_PAGE && !isActive.value);

const codePreview = computed(() => props.source.split("\n").slice(0, 5).join("\n"));

const sandboxUrl = computed(() => `${SANDBOX_ORIGIN}/index.html`);

function checkCodeSize(): boolean {
  codeSizeError.value = null;
  const byteLength = new TextEncoder().encode(props.source).byteLength;
  if (byteLength > MAX_CODE_SIZE_BYTES) {
    codeSizeError.value = `Code exceeds maximum size (${MAX_CODE_SIZE_BYTES / 1024}KB)`;
    return false;
  }
  return true;
}

function play(): void {
  if (!checkCodeSize()) return;
  if (isAtLimit.value) return;

  if (!started.value) {
    // Mounts the iframe. Once it finishes loading, `onIframeLoad` calls
    // `bridge.reset()` to begin the init handshake.
    started.value = true;
    return;
  }

  if (bridge.state.value === "ready") {
    bridge.execute(props.source, {
      height: props.height,
      network: [],
      autoplay: props.autoplay,
    });
    return;
  }

  // stopped / error: re-run the full init handshake.
  bridge.reset();
}

function handleStop(): void {
  bridge.stop();
}

function handleReset(): void {
  codeSizeError.value = null;
  bridge.reset();
}

function onIframeLoad(): void {
  if (bridge.state.value === "idle") {
    bridge.reset();
  }
}

// Single consolidated watcher: tracks how many runtimes on this page are
// currently active (for the MAX_IFRAMES_PER_PAGE guard) and triggers
// autoplay once the sandbox reports it is ready.
watch(() => bridge.state.value, (newState, oldState) => {
  const wasActive = oldState === "executing" || oldState === "initializing";
  const isNowActive = newState === "executing" || newState === "initializing";
  if (isNowActive && !wasActive) {
    activeCount.value++;
  } else if (!isNowActive && wasActive) {
    activeCount.value = Math.max(0, activeCount.value - 1);
  }

  if (newState === "ready" && props.autoplay) {
    if (!checkCodeSize()) return;
    bridge.execute(props.source, {
      height: props.height,
      network: [],
      autoplay: props.autoplay,
    });
  }
});

onUnmounted(() => {
  bridge.cleanup();
});
</script>

<template>
  <div class="runtime-host" :data-runtime="runtime">
    <!-- Not yet started: static placeholder -->
    <div
      v-if="!started"
      data-testid="runtime-placeholder"
      :data-glyphquire-runtime-placeholder="runtime"
      class="runtime-placeholder"
    >
      <pre class="runtime-code-preview">{{ codePreview }}</pre>
      <button v-if="!isAtLimit" data-testid="runtime-play" class="runtime-play-btn" @click="play">
        ▶ Run
      </button>
      <p v-else class="runtime-limit-msg">
        Maximum active runtimes reached. Stop another runtime to start this one.
      </p>
    </div>

    <!-- Started: iframe is mounted for the remainder of this component's life -->
    <div v-else class="runtime-live">
      <iframe
        ref="iframeRef"
        :src="sandboxUrl"
        :style="{
          height: bridge.iframeHeight.value + 'px',
          visibility: bridge.state.value === 'executing' ? 'visible' : 'hidden',
        }"
        sandbox="allow-scripts"
        @load="onIframeLoad"
      />

      <div v-if="bridge.state.value === 'initializing'" class="runtime-placeholder">
        <pre class="runtime-code-preview">{{ codePreview }}</pre>
        <div class="runtime-spinner">Loading…</div>
      </div>

      <div v-else-if="bridge.state.value === 'ready' || bridge.state.value === 'stopped'" class="runtime-placeholder">
        <pre class="runtime-code-preview">{{ codePreview }}</pre>
        <button
          v-if="!isAtLimit"
          data-testid="runtime-play"
          class="runtime-play-btn"
          @click="play"
        >
          ▶ Run
        </button>
        <p v-else class="runtime-limit-msg">
          Maximum active runtimes reached. Stop another runtime to start this one.
        </p>
      </div>

      <div v-else-if="bridge.state.value === 'executing'" class="runtime-controls">
        <button data-testid="runtime-stop" class="runtime-stop-btn" @click="handleStop">
          ■ Stop
        </button>
      </div>

      <div v-else-if="bridge.state.value === 'error'" class="runtime-error">
        <p class="runtime-error-msg">{{ bridge.error.value?.message }}</p>
        <p v-if="bridge.error.value?.line" class="runtime-error-line">
          Line {{ bridge.error.value.line }}
        </p>
        <button data-testid="runtime-reset" class="runtime-reset-btn" @click="handleReset">
          Reset
        </button>
      </div>
    </div>

    <!-- Code size error (shown regardless of state) -->
    <div v-if="codeSizeError" class="runtime-error">
      <p class="runtime-error-msg">{{ codeSizeError }}</p>
    </div>
  </div>
</template>
