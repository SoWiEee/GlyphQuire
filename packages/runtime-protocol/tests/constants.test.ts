import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  EXECUTION_TIMEOUT_MS,
  MAX_IFRAMES_PER_PAGE,
  MAX_MESSAGE_RATE,
  MAX_CODE_SIZE_BYTES,
  RESIZE_MIN_HEIGHT,
  RESIZE_MAX_HEIGHT,
} from "../src/index.js";

describe("runtime-protocol constants", () => {
  it("PROTOCOL_VERSION is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("all constants are positive integers", () => {
    for (const value of [
      EXECUTION_TIMEOUT_MS,
      MAX_IFRAMES_PER_PAGE,
      MAX_MESSAGE_RATE,
      MAX_CODE_SIZE_BYTES,
      RESIZE_MIN_HEIGHT,
      RESIZE_MAX_HEIGHT,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("EXECUTION_TIMEOUT_MS is 30000", () => {
    expect(EXECUTION_TIMEOUT_MS).toBe(30_000);
  });

  it("MAX_IFRAMES_PER_PAGE is 8", () => {
    expect(MAX_IFRAMES_PER_PAGE).toBe(8);
  });

  it("MAX_MESSAGE_RATE is 60", () => {
    expect(MAX_MESSAGE_RATE).toBe(60);
  });

  it("MAX_CODE_SIZE_BYTES is 65536", () => {
    expect(MAX_CODE_SIZE_BYTES).toBe(65_536);
  });

  it("RESIZE_MIN_HEIGHT is 100 and RESIZE_MAX_HEIGHT is 2000", () => {
    expect(RESIZE_MIN_HEIGHT).toBe(100);
    expect(RESIZE_MAX_HEIGHT).toBe(2000);
  });
});
