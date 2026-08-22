import type { Database } from "@glyphquire/database";
import {
  assertRateLimitArguments,
  decisionFor,
  type Clock,
  type RateLimitDecision,
  type RateLimitPort,
} from "./rate-limit.js";

interface BucketRow {
  request_count: number;
  window_started_at_ms: string;
}

export class PostgresRateLimitAdapter implements RateLimitPort {
  readonly distributed = true;
  readonly #clock: Clock;
  readonly #db: Database;
  #initialization: Promise<void> | undefined;

  constructor(db: Database, options: { clock?: Clock } = {}) {
    this.#db = db;
    this.#clock = options.clock ?? Date.now;
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#probe().catch((error: unknown) => {
      this.#initialization = undefined;
      throw error;
    });
    return this.#initialization;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    assertRateLimitArguments(key, limit, windowMs);
    await this.initialize();

    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("rate-limit clock must return a nonnegative safe integer");
    }
    const nowIso = new Date(now).toISOString();
    const rows = await this.#db.$client<BucketRow[]>`
      insert into rate_limit_buckets (
        bucket_key,
        window_started_at,
        request_count,
        updated_at
      ) values (
        ${key},
        ${nowIso},
        1,
        ${nowIso}
      )
      on conflict (bucket_key) do update set
        window_started_at = case
          when ${nowIso} >= rate_limit_buckets.window_started_at
            + ${windowMs} * interval '1 millisecond'
          then ${nowIso}
          else rate_limit_buckets.window_started_at
        end,
        request_count = case
          when ${nowIso} >= rate_limit_buckets.window_started_at
            + ${windowMs} * interval '1 millisecond'
          then 1
          else least(rate_limit_buckets.request_count + 1, 2147483647)
        end,
        updated_at = ${nowIso}
      returning
        request_count,
        ((extract(epoch from window_started_at) * 1000)::bigint)::text
          as window_started_at_ms
    `;
    const row = rows[0];
    if (!row) throw new Error("rate-limit bucket update returned no row");

    return decisionFor(row.request_count, Number(row.window_started_at_ms), now, limit, windowMs);
  }

  async #probe() {
    await this.#db.$client`select bucket_key from rate_limit_buckets limit 0`;
  }
}
