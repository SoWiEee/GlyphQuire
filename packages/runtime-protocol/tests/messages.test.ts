import { describe, expect, it } from "vitest";
import {
  parseHostMessage,
  parseSandboxMessage,
  type HostMessage,
  type SandboxMessage,
} from "../src/index.js";

describe("parseHostMessage", () => {
  const validInit: HostMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:init",
    payload: { runtime: "p5", origin: "http://localhost:5173" },
  };

  const validExecute: HostMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:execute",
    payload: {
      source: "sketch.background(0);",
      props: { height: 400, network: [], autoplay: false },
    },
  };

  const validStop: HostMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:stop",
  };

  it("parses valid runtime:init", () => {
    expect(parseHostMessage(validInit)).toEqual(validInit);
  });

  it("parses valid runtime:execute", () => {
    expect(parseHostMessage(validExecute)).toEqual(validExecute);
  });

  it("parses valid runtime:stop", () => {
    expect(parseHostMessage(validStop)).toEqual(validStop);
  });

  it("returns null for invalid v", () => {
    expect(parseHostMessage({ ...validInit, v: 2 })).toBeNull();
  });

  it("returns null for missing id", () => {
    const { id: _, ...noId } = validInit;
    expect(parseHostMessage(noId)).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(parseHostMessage({ ...validInit, type: "runtime:unknown" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseHostMessage("hello")).toBeNull();
    expect(parseHostMessage(42)).toBeNull();
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage(undefined)).toBeNull();
  });

  it("returns null for runtime:execute with missing source", () => {
    expect(
      parseHostMessage({
        v: 1,
        id: "abc-123",
        type: "runtime:execute",
        payload: { props: { height: 400, network: [], autoplay: false } },
      }),
    ).toBeNull();
  });

  it("returns null for runtime:init with invalid runtime type", () => {
    expect(
      parseHostMessage({
        v: 1,
        id: "abc-123",
        type: "runtime:init",
        payload: { runtime: "webgl", origin: "http://localhost:5173" },
      }),
    ).toBeNull();
  });
});

describe("parseSandboxMessage", () => {
  const validReady: SandboxMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:ready",
  };

  const validResize: SandboxMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:resize",
    payload: { height: 500 },
  };

  const validError: SandboxMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:error",
    payload: { message: "ReferenceError: x is not defined", line: 5 },
  };

  const validStopped: SandboxMessage = {
    v: 1,
    id: "abc-123",
    type: "runtime:stopped",
  };

  it("parses valid runtime:ready", () => {
    expect(parseSandboxMessage(validReady)).toEqual(validReady);
  });

  it("parses valid runtime:resize", () => {
    expect(parseSandboxMessage(validResize)).toEqual(validResize);
  });

  it("parses valid runtime:error", () => {
    expect(parseSandboxMessage(validError)).toEqual(validError);
  });

  it("parses valid runtime:error without line", () => {
    const errorNoLine: SandboxMessage = {
      v: 1,
      id: "abc-123",
      type: "runtime:error",
      payload: { message: "Error" },
    };
    expect(parseSandboxMessage(errorNoLine)).toEqual(errorNoLine);
  });

  it("parses valid runtime:stopped", () => {
    expect(parseSandboxMessage(validStopped)).toEqual(validStopped);
  });

  it("returns null for invalid v", () => {
    expect(parseSandboxMessage({ ...validReady, v: 0 })).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(parseSandboxMessage({ ...validReady, type: "runtime:hack" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseSandboxMessage(null)).toBeNull();
    expect(parseSandboxMessage([])).toBeNull();
  });

  it("returns null for runtime:resize with negative height", () => {
    expect(
      parseSandboxMessage({
        v: 1,
        id: "abc-123",
        type: "runtime:resize",
        payload: { height: -1 },
      }),
    ).toBeNull();
  });
});
