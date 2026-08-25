import { z } from "zod";
import { PROTOCOL_VERSION } from "./constants.js";

const runtimePropsSchema = z.object({
  height: z.number().int().positive(),
  network: z.array(z.string()),
  autoplay: z.boolean(),
});

const baseFields = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
};

const initMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:init"),
  payload: z.object({
    runtime: z.enum(["p5", "canvas"]),
    origin: z.string().min(1),
  }),
});

const executeMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:execute"),
  payload: z.object({
    source: z.string(),
    props: runtimePropsSchema,
  }),
});

const stopMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:stop"),
});

export const hostMessageSchema = z.discriminatedUnion("type", [
  initMessage,
  executeMessage,
  stopMessage,
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;

const readyMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:ready"),
});

const resizeMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:resize"),
  payload: z.object({
    height: z.number().int().positive(),
  }),
});

const errorMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:error"),
  payload: z.object({
    message: z.string(),
    line: z.number().int().optional(),
  }),
});

const stoppedMessage = z.object({
  ...baseFields,
  type: z.literal("runtime:stopped"),
});

export const sandboxMessageSchema = z.discriminatedUnion("type", [
  readyMessage,
  resizeMessage,
  errorMessage,
  stoppedMessage,
]);

export type SandboxMessage = z.infer<typeof sandboxMessageSchema>;

export function parseHostMessage(data: unknown): HostMessage | null {
  const result = hostMessageSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function parseSandboxMessage(data: unknown): SandboxMessage | null {
  const result = sandboxMessageSchema.safeParse(data);
  return result.success ? result.data : null;
}
