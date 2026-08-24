import { describe, it, expect } from "vitest";
import { createRegistry } from "./builtins.js";
import { BlockRegistry, registerBuiltin, RESERVED_NAMES } from "./registry.js";
import { calloutBlock } from "./blocks/callout.js";

describe("registry", () => {
  it("registers all reserved built-in names", () => {
    const registry = createRegistry();
    for (const name of RESERVED_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("rejects duplicate registration", () => {
    const registry = createRegistry();
    expect(() => registry.register(registry.get("callout")!)).toThrow();
  });

  it("rejects public registration of reserved built-in names", () => {
    const registry = new BlockRegistry();

    expect(() => registry.register({ ...calloutBlock })).toThrow(/reserved/);
  });

  it("allows registration of non-reserved names", () => {
    const registry = new BlockRegistry();

    registry.register({ ...calloutBlock, name: "custom" });

    expect(registry.has("custom")).toBe(true);
  });

  it("captures a public definition name exactly once", () => {
    const names = ["custom", "callout"];
    let reads = 0;
    const definition = {
      ...calloutBlock,
      get name(): string {
        reads += 1;
        return names.shift() ?? "callout";
      },
    };
    const registry = new BlockRegistry();

    registry.register(definition);

    expect(reads).toBe(1);
    expect(registry.has("custom")).toBe(true);
    expect(registry.has("callout")).toBe(false);
  });

  it("captures and validates a built-in definition name exactly once", () => {
    const names = ["custom", "callout"];
    let reads = 0;
    const definition = {
      ...calloutBlock,
      get name(): string {
        reads += 1;
        return names.shift() ?? "callout";
      },
    };
    const registry = new BlockRegistry();

    expect(() => registerBuiltin(registry, definition)).toThrow(/reserved/);
    expect(reads).toBe(1);
    expect(registry.has("custom")).toBe(false);
    expect(registry.has("callout")).toBe(false);
  });

  it("keeps public registration single-argument and bypasses it for built-ins", () => {
    const originalRegister = BlockRegistry.prototype.register;
    const observedArguments: unknown[][] = [];
    BlockRegistry.prototype.register = function (...args) {
      observedArguments.push(args);
      return Reflect.apply(originalRegister, this, args);
    };

    let registry: BlockRegistry;
    try {
      registry = createRegistry();
    } finally {
      BlockRegistry.prototype.register = originalRegister;
    }

    expect(BlockRegistry.prototype.register.length).toBe(1);
    expect(observedArguments.every((args) => args.length <= 1)).toBe(true);
    for (const name of RESERVED_NAMES) {
      expect(registry.has(name)).toBe(true);
    }

    expect(() =>
      Reflect.apply(registry.register, registry, [{ ...calloutBlock }, Symbol("fake-capability")]),
    ).toThrow(/reserved/);

    const leakedCapability = observedArguments.find((args) => args.length > 1)?.[1];
    if (leakedCapability !== undefined) {
      expect(() =>
        Reflect.apply(registry.register, registry, [{ ...calloutBlock }, leakedCapability]),
      ).toThrow(/reserved/);
    }
  });

  it("isolates built-in snapshots across registries", () => {
    const first = createRegistry();
    const stored = first.get("callout")!;

    try {
      Reflect.set(stored, "name", "custom");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
    try {
      Reflect.apply(Array.prototype.push, stored.capabilities, ["network-request"]);
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }

    const second = createRegistry();
    expect(second.get("callout")?.name).toBe("callout");
    expect(second.get("callout")?.capabilities).toEqual(["static"]);
  });

  it("isolates caller-owned definitions after public registration", () => {
    const definition = {
      ...calloutBlock,
      name: "custom",
      capabilities: [...calloutBlock.capabilities],
    };
    const registry = new BlockRegistry();

    registry.register(definition);
    definition.name = "changed";
    definition.capabilities.push("network-request");

    expect(registry.get("custom")?.name).toBe("custom");
    expect(registry.get("custom")?.capabilities).toEqual(["static"]);
    expect(registry.has("changed")).toBe(false);
  });

  it("returns immutable stored definition shells and capabilities", () => {
    const registry = new BlockRegistry();
    registry.register({
      ...calloutBlock,
      name: "custom",
      capabilities: [...calloutBlock.capabilities],
    });
    const stored = registry.get("custom")!;

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.capabilities)).toBe(true);
    expect(() => {
      // @ts-expect-error stored definition names are readonly
      stored.name = "changed";
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error stored transform functions are readonly
      stored.fromDirective = calloutBlock.fromDirective;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error stored schemas are readonly
      stored.schema = calloutBlock.schema;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error stored capabilities are readonly
      stored.capabilities.push("network-request");
    }).toThrow(TypeError);
    expect(stored.name).toBe("custom");
    expect(stored.capabilities).toEqual(["static"]);
  });
});
