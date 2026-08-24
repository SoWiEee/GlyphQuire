import { randomUUID } from "node:crypto";
import type { Database } from "@glyphquire/database";
import {
  assertClockValue,
  assertRateLimitArguments,
  assertReservationToken,
  decisionFor,
  type Clock,
  type RateLimitDecision,
  type RateLimitPort,
  type RateLimitReservation,
  type RateLimitReservationToken,
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
    assertClockValue(now);
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

  async reserve(key: string, limit: number, windowMs: number): Promise<RateLimitReservation> {
    assertRateLimitArguments(key, limit, windowMs);
    await this.initialize();

    const now = this.#clock();
    assertClockValue(now);
    const nowIso = new Date(now).toISOString();
    const reservationId = randomUUID();

    return this.#db.$client.begin(async (sql) => {
      await sql`
        insert into rate_limit_buckets (
          bucket_key,
          window_started_at,
          request_count,
          updated_at
        ) values (
          ${key},
          ${nowIso},
          0,
          ${nowIso}
        )
        on conflict (bucket_key) do nothing
      `;
      const rows = await sql<BucketRow[]>`
        select
          request_count,
          ((extract(epoch from window_started_at) * 1000)::bigint)::text
            as window_started_at_ms
        from rate_limit_buckets
        where bucket_key = ${key}
        for update
      `;
      const row = rows[0];
      if (!row) throw new Error("rate-limit reservation found no bucket");

      const startedAt = Number(row.window_started_at_ms);
      const expired = now >= startedAt + windowMs;
      if (!expired && row.request_count >= limit) {
        return {
          acquired: false,
          decision: {
            ...decisionFor(row.request_count, startedAt, now, limit, windowMs),
            allowed: false,
            remaining: 0,
          },
          token: null,
        };
      }

      const nextStartedAt = expired ? now : startedAt;
      const nextCount = expired ? 1 : row.request_count + 1;
      await sql`
        update rate_limit_buckets
        set
          window_started_at = ${new Date(nextStartedAt).toISOString()},
          request_count = ${nextCount},
          updated_at = ${nowIso}
        where bucket_key = ${key}
      `;
      await sql`
        insert into rate_limit_reservations (
          reservation_id,
          bucket_key,
          window_started_at,
          created_at,
          released_at
        ) values (
          ${reservationId},
          ${key},
          ${new Date(nextStartedAt).toISOString()},
          ${nowIso},
          null
        )
      `;

      return {
        acquired: true,
        decision: decisionFor(nextCount, nextStartedAt, now, limit, windowMs),
        token: { reservationId, key, windowStartedAt: nextStartedAt },
      };
    });
  }

  async release(reservation: RateLimitReservationToken): Promise<void> {
    assertReservationToken(reservation);
    await this.initialize();

    const now = this.#clock();
    assertClockValue(now);
    await this.#db.$client`
      with released_reservation as (
        update rate_limit_reservations
        set released_at = ${new Date(now).toISOString()}
        where reservation_id = ${reservation.reservationId}
          and bucket_key = ${reservation.key}
          and window_started_at = ${new Date(reservation.windowStartedAt).toISOString()}
          and released_at is null
        returning bucket_key, window_started_at
      )
      update rate_limit_buckets as bucket
      set
        request_count = bucket.request_count - 1,
        updated_at = ${new Date(now).toISOString()}
      from released_reservation
      where bucket.bucket_key = released_reservation.bucket_key
        and bucket.window_started_at = released_reservation.window_started_at
        and bucket.request_count > 0
    `;
  }

  async #probe() {
    const probeRollback = new Error("rate-limit capability probe rollback");
    const probeKey = `rl:capability-probe:${randomUUID()}`;
    const probeReservationId = randomUUID();
    try {
      await this.#db.$client.begin(async (sql) => {
        const nowIso = new Date(0).toISOString();
        await sql`
          insert into rate_limit_buckets (
            bucket_key,
            window_started_at,
            request_count,
            updated_at
          ) values (
            ${probeKey},
            ${nowIso},
            1,
            ${nowIso}
          )
        `;
        await sql`
          update rate_limit_buckets
          set request_count = 2
          where bucket_key = ${probeKey}
        `;
        await sql`
          insert into rate_limit_reservations (
            reservation_id,
            bucket_key,
            window_started_at,
            created_at,
            released_at
          ) values (
            ${probeReservationId},
            ${probeKey},
            ${nowIso},
            ${nowIso},
            null
          )
        `;
        await sql`
          update rate_limit_reservations
          set released_at = ${nowIso}
          where reservation_id = ${probeReservationId}
        `;
        const reservationRows = await sql<{ released: boolean }[]>`
          select released_at is not null as released
          from rate_limit_reservations
          where reservation_id = ${probeReservationId}
        `;
        if (reservationRows[0]?.released !== true) {
          throw new Error("rate-limit reservation capability probe returned an unexpected row");
        }
        const rows = await sql<{ request_count: number }[]>`
          select request_count
          from rate_limit_buckets
          where bucket_key = ${probeKey}
        `;
        if (rows[0]?.request_count !== 2) {
          throw new Error("rate-limit capability probe returned an unexpected row");
        }
        throw probeRollback;
      });
    } catch (error) {
      if (error === probeRollback) return;
      throw error;
    }
  }
}
