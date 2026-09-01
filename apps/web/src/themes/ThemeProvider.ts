import { computed, ref, watch, type InjectionKey, type Ref, type ComputedRef } from "vue";
import {
  resolveTheme,
  tokensToCssVariables,
  resolveVariants,
  defaultTheme,
  defaultDarkTheme,
  defaultVariants,
  type ThemeTokens,
  type ThemeTokenOverrides,
  type ThemeComponentVariants,
} from "@glyphquire/theme-engine";

export interface ThemeContext {
  readonly tokens: ComputedRef<ThemeTokens>;
  readonly variants: ComputedRef<ThemeComponentVariants>;
  readonly cssVariables: ComputedRef<Record<string, string>>;
  readonly isDark: Ref<boolean>;
  setTheme(tokens: ThemeTokenOverrides, variants?: Partial<ThemeComponentVariants>): void;
  setDraftTokens(overrides: ThemeTokenOverrides): void;
  setDraftVariants(overrides: Partial<ThemeComponentVariants>): void;
  commitDraft(): void;
  resetDraft(): void;
  applyToDocument(): void;
}

export const THEME_INJECTION_KEY: InjectionKey<ThemeContext> = Symbol("glyphquire-theme");

/**
 * The document root is the theme boundary for rendered blocks.  Component
 * styles consume these attributes instead of relying on node-local defaults,
 * which lets a theme change update an existing document without rebuilding its
 * ProseMirror nodes.  Camel-cased component keys use kebab-case in HTML.
 */
const VARIANT_ATTRIBUTE_DEFINITIONS = [
  { component: "heading", property: "decoration", attribute: "data-gq-heading-decoration" },
  { component: "quote", property: "variant", attribute: "data-gq-quote-variant" },
  { component: "callout", property: "variant", attribute: "data-gq-callout-variant" },
  { component: "callout", property: "animation", attribute: "data-gq-callout-animation" },
  { component: "code", property: "variant", attribute: "data-gq-code-variant" },
  { component: "toggle", property: "variant", attribute: "data-gq-toggle-variant" },
  { component: "tabs", property: "variant", attribute: "data-gq-tabs-variant" },
  { component: "stickyNote", property: "variant", attribute: "data-gq-sticky-note-variant" },
] as const;

const VARIANT_ATTRIBUTE_NAMES = VARIANT_ATTRIBUTE_DEFINITIONS.map(({ attribute }) => attribute);

function mergeVariantOverrides(
  current: Partial<ThemeComponentVariants>,
  incoming: Partial<ThemeComponentVariants>,
): Partial<ThemeComponentVariants> {
  const merged: Record<string, Record<string, string | undefined>> = {};

  for (const [component, config] of Object.entries(current)) {
    if (config) merged[component] = { ...(config as Record<string, string | undefined>) };
  }
  for (const [component, config] of Object.entries(incoming)) {
    if (config) {
      merged[component] = {
        ...merged[component],
        ...(config as Record<string, string | undefined>),
      };
    } else {
      delete merged[component];
    }
  }

  return merged as Partial<ThemeComponentVariants>;
}

export function useTheme(): ThemeContext {
  const isDark = ref(false);
  const baseTokenOverrides = ref<ThemeTokenOverrides>({});
  const baseVariantOverrides = ref<Partial<ThemeComponentVariants>>({});
  const draftTokenOverrides = ref<ThemeTokenOverrides | null>(null);
  const draftVariantOverrides = ref<Partial<ThemeComponentVariants> | null>(null);
  const appliedCssVariableNames = new Set<string>();

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
    tokenOverrides: ThemeTokenOverrides,
    variantOverrides?: Partial<ThemeComponentVariants>,
  ) {
    baseTokenOverrides.value = tokenOverrides;
    if (variantOverrides) baseVariantOverrides.value = variantOverrides;
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function setDraftTokens(overrides: ThemeTokenOverrides) {
    draftTokenOverrides.value = overrides;
  }

  function setDraftVariants(overrides: Partial<ThemeComponentVariants>) {
    draftVariantOverrides.value = mergeVariantOverrides(
      draftVariantOverrides.value ?? baseVariantOverrides.value,
      overrides,
    );
  }

  function commitDraft() {
    if (draftTokenOverrides.value) baseTokenOverrides.value = draftTokenOverrides.value;
    if (draftVariantOverrides.value) {
      baseVariantOverrides.value = mergeVariantOverrides(
        baseVariantOverrides.value,
        draftVariantOverrides.value,
      );
    }
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function resetDraft() {
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function applyToDocument() {
    if (typeof document === "undefined") return;

    const vars = cssVariables.value;
    const root = document.documentElement;

    for (const key of appliedCssVariableNames) {
      if (!(key in vars)) root.style.removeProperty(key);
    }
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
      appliedCssVariableNames.add(key);
    }

    for (const attribute of VARIANT_ATTRIBUTE_NAMES) root.removeAttribute(attribute);
    for (const definition of VARIANT_ATTRIBUTE_DEFINITIONS) {
      const config = variants.value[definition.component] as
        | Record<string, string | undefined>
        | undefined;
      const value = config?.[definition.property];
      if (typeof value === "string") root.setAttribute(definition.attribute, value);
    }
  }

  watch([tokens, variants], applyToDocument, { flush: "sync", immediate: true });

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
