import type { ThemeTokens } from "./tokens.js";

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

export function tokensToCssVariables(tokens: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(tokens.color)) {
    vars[`--gq-color-${camelToKebab(key)}`] = value;
  }

  for (const [key, value] of Object.entries(tokens.typography)) {
    vars[`--gq-typography-${camelToKebab(key)}`] = value;
  }

  for (const [key, value] of Object.entries(tokens.radius)) {
    vars[`--gq-radius-${camelToKebab(key)}`] = value;
  }

  for (const [key, value] of Object.entries(tokens.spacing)) {
    vars[`--gq-spacing-${key}`] = value;
  }

  return vars;
}
