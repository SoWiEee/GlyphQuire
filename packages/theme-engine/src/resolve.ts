import type { ThemeTokens } from "./tokens.js";

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

export function mergeTokens(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens {
  return {
    color: overrides.color ? { ...base.color, ...overrides.color } : { ...base.color },
    typography: overrides.typography
      ? { ...base.typography, ...overrides.typography }
      : { ...base.typography },
    radius: overrides.radius ? { ...base.radius, ...overrides.radius } : { ...base.radius },
    spacing: overrides.spacing ? { ...base.spacing, ...overrides.spacing } : { ...base.spacing },
  };
}

export function resolveTheme(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens {
  return deepFreeze(mergeTokens(base, overrides));
}
