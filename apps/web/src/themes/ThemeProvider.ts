import { computed, ref, type InjectionKey, type Ref, type ComputedRef } from "vue";
import {
  resolveTheme,
  tokensToCssVariables,
  resolveVariants,
  defaultTheme,
  defaultDarkTheme,
  defaultVariants,
  type ThemeTokens,
  type ThemeComponentVariants,
} from "@glyphquire/theme-engine";

export interface ThemeContext {
  readonly tokens: ComputedRef<ThemeTokens>;
  readonly variants: ComputedRef<ThemeComponentVariants>;
  readonly cssVariables: ComputedRef<Record<string, string>>;
  readonly isDark: Ref<boolean>;
  setTheme(tokens: Partial<ThemeTokens>, variants?: Partial<ThemeComponentVariants>): void;
  setDraftTokens(overrides: Partial<ThemeTokens>): void;
  setDraftVariants(overrides: Partial<ThemeComponentVariants>): void;
  commitDraft(): void;
  resetDraft(): void;
  applyToDocument(): void;
}

export const THEME_INJECTION_KEY: InjectionKey<ThemeContext> = Symbol("glyphquire-theme");

export function useTheme(): ThemeContext {
  const isDark = ref(false);
  const baseTokenOverrides = ref<Partial<ThemeTokens>>({});
  const baseVariantOverrides = ref<Partial<ThemeComponentVariants>>({});
  const draftTokenOverrides = ref<Partial<ThemeTokens> | null>(null);
  const draftVariantOverrides = ref<Partial<ThemeComponentVariants> | null>(null);

  const baseTheme = computed(() => (isDark.value ? defaultDarkTheme : defaultTheme));

  const tokens = computed(() => {
    const effective = draftTokenOverrides.value ?? baseTokenOverrides.value;
    return resolveTheme(baseTheme.value, effective);
  });

  const variants = computed(() => {
    const effective = draftVariantOverrides.value ?? baseVariantOverrides.value;
    return resolveVariants(defaultVariants, effective);
  });

  const cssVariables = computed(() => tokensToCssVariables(tokens.value));

  function setTheme(
    tokenOverrides: Partial<ThemeTokens>,
    variantOverrides?: Partial<ThemeComponentVariants>,
  ) {
    baseTokenOverrides.value = tokenOverrides;
    if (variantOverrides) baseVariantOverrides.value = variantOverrides;
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function setDraftTokens(overrides: Partial<ThemeTokens>) {
    draftTokenOverrides.value = overrides;
  }

  function setDraftVariants(overrides: Partial<ThemeComponentVariants>) {
    draftVariantOverrides.value = overrides;
  }

  function commitDraft() {
    if (draftTokenOverrides.value) baseTokenOverrides.value = draftTokenOverrides.value;
    if (draftVariantOverrides.value) baseVariantOverrides.value = draftVariantOverrides.value;
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function resetDraft() {
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function applyToDocument() {
    const vars = cssVariables.value;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
  }

  return {
    tokens,
    variants,
    cssVariables,
    isDark,
    setTheme,
    setDraftTokens,
    setDraftVariants,
    commitDraft,
    resetDraft,
    applyToDocument,
  };
}
