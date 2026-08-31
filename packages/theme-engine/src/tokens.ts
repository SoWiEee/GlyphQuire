export interface ThemeTokens {
  readonly color: {
    readonly background: string;
    readonly surface: string;
    readonly surfaceMuted: string;
    readonly foreground: string;
    readonly muted: string;
    readonly accent: string;
    readonly accentContrast: string;
    readonly border: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
  };
  readonly typography: {
    readonly bodyFont: string;
    readonly headingFont: string;
    readonly monoFont: string;
  };
  readonly radius: {
    readonly sm: string;
    readonly md: string;
    readonly lg: string;
  };
  readonly spacing: Readonly<Record<string, string>>;
}

export type ThemeTokenOverrides = {
  color?: Partial<ThemeTokens["color"]>;
  typography?: Partial<ThemeTokens["typography"]>;
  radius?: Partial<ThemeTokens["radius"]>;
  spacing?: Readonly<Record<string, string>>;
};

export const defaultTheme: ThemeTokens = {
  color: {
    background: "#f7f3ed",
    surface: "#fffdf9",
    surfaceMuted: "#eee8df",
    foreground: "#2e2924",
    muted: "#6f675f",
    accent: "#4f5f9f",
    accentContrast: "#ffffff",
    border: "#9c8e7f",
    success: "#31724d",
    warning: "#8a5a16",
    danger: "#a13d3d",
  },
  typography: {
    bodyFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    headingFont: '"Source Serif 4", Georgia, serif',
    monoFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  },
  radius: {
    sm: "0.25rem",
    md: "0.5rem",
    lg: "0.75rem",
  },
  spacing: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "1rem",
    lg: "1.5rem",
    xl: "2rem",
    "2xl": "3rem",
  },
};

export const defaultDarkTheme: ThemeTokens = {
  color: {
    background: "#16171d",
    surface: "#20222b",
    surfaceMuted: "#2b2e3a",
    foreground: "#f3f1ed",
    muted: "#b8b3ac",
    accent: "#aab5f0",
    accentContrast: "#171924",
    border: "#697087",
    success: "#8fd3aa",
    warning: "#f0c477",
    danger: "#f0a0a0",
  },
  typography: {
    bodyFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    headingFont: '"Source Serif 4", Georgia, serif',
    monoFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  },
  radius: {
    sm: "0.25rem",
    md: "0.5rem",
    lg: "0.75rem",
  },
  spacing: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "1rem",
    lg: "1.5rem",
    xl: "2rem",
    "2xl": "3rem",
  },
};

export const warmSepiaTheme: ThemeTokenOverrides = {
  color: {
    background: "#fdf6e3",
    surface: "#fffaf0",
    surfaceMuted: "#f4ead0",
    foreground: "#3b2e1a",
    muted: "#8b7355",
    accent: "#b58900",
    accentContrast: "#3b2e1a",
    border: "#e0d5b7",
    success: "#4f7d3a",
    warning: "#9b6a1f",
    danger: "#9b3f2f",
  },
  typography: {
    headingFont: '"Source Serif 4", Georgia, serif',
  },
};
