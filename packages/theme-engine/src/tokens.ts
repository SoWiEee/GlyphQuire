export interface ThemeTokens {
  readonly color: {
    readonly background: string;
    readonly foreground: string;
    readonly muted: string;
    readonly accent: string;
    readonly border: string;
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

export const defaultTheme: ThemeTokens = {
  color: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    muted: "#6b7280",
    accent: "#2563eb",
    border: "#e5e7eb",
  },
  typography: {
    bodyFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    headingFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
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
    background: "#0f172a",
    foreground: "#f1f5f9",
    muted: "#94a3b8",
    accent: "#60a5fa",
    border: "#334155",
  },
  typography: {
    bodyFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    headingFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
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

export const warmSepiaTheme: Partial<ThemeTokens> = {
  color: {
    background: "#fdf6e3",
    foreground: "#3b2e1a",
    muted: "#8b7355",
    accent: "#b58900",
    border: "#e0d5b7",
  },
};
