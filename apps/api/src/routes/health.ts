import { Hono } from "hono";

export interface Phase6ReadinessState {
  readonly healthy: boolean;
  readonly ready: boolean;
  readonly restartRequested: boolean;
  readonly requestCount: number;
  readonly errorCount: number;
  setHealthy(value: boolean): void;
  setReady(value: boolean): void;
  recordRequest(): void;
  recordError(): void;
}

export interface ReadinessStateOptions {
  onHealthFailure?: () => void;
}

export function createReadinessState(options: ReadinessStateOptions = {}): Phase6ReadinessState {
  let healthy = true;
  let ready = true;
  let restartRequested = false;
  let requestCount = 0;
  let errorCount = 0;

  return {
    get healthy() {
      return healthy;
    },
    get ready() {
      return ready;
    },
    get restartRequested() {
      return restartRequested;
    },
    get requestCount() {
      return requestCount;
    },
    get errorCount() {
      return errorCount;
    },
    setHealthy(value) {
      healthy = value;
      if (!value) ready = false;
      if (!value && !restartRequested) {
        restartRequested = true;
        try {
          options.onHealthFailure?.();
        } catch {
          // A restart hook must not replace the health response.
        }
      }
    },
    setReady(value) {
      ready = value;
    },
    recordRequest() {
      requestCount += 1;
    },
    recordError() {
      errorCount += 1;
    },
  };
}

function metrics(state: Phase6ReadinessState): string {
  return [
    "# TYPE glyphquire_health gauge",
    `glyphquire_health ${state.healthy ? 1 : 0}`,
    "# TYPE glyphquire_readiness gauge",
    `glyphquire_readiness ${state.ready ? 1 : 0}`,
    "# TYPE glyphquire_accepting_traffic gauge",
    `glyphquire_accepting_traffic ${state.ready ? 1 : 0}`,
    "# TYPE glyphquire_restart_requested_total counter",
    `glyphquire_restart_requested_total ${state.restartRequested ? 1 : 0}`,
    "# TYPE glyphquire_http_requests_total counter",
    `glyphquire_http_requests_total ${state.requestCount}`,
    "# TYPE glyphquire_http_errors_total counter",
    `glyphquire_http_errors_total ${state.errorCount}`,
    "",
  ].join("\n");
}

export function createHealthRoutes(state: Phase6ReadinessState = createReadinessState()) {
  return new Hono()
    .get("/health", (context) => {
      state.recordRequest();
      const healthy = state.healthy;
      if (!healthy) state.recordError();
      return context.json(
        {
          status: healthy ? ("ok" as const) : ("unhealthy" as const),
          timestamp: new Date().toISOString(),
        },
        healthy ? 200 : 503,
      );
    })
    .get("/ready", (context) => {
      state.recordRequest();
      const ready = state.ready && state.healthy;
      if (!ready) state.recordError();
      return context.json(
        {
          status: ready ? ("ready" as const) : ("not_ready" as const),
          acceptTraffic: ready,
          timestamp: new Date().toISOString(),
        },
        ready ? 200 : 503,
      );
    })
    .get("/metrics", (context) => {
      context.header("content-type", "text/plain; version=0.0.4");
      return context.body(metrics(state));
    });
}

/** Default route set retained for callers that only need the legacy health endpoint. */
export const healthRoutes = createHealthRoutes();
