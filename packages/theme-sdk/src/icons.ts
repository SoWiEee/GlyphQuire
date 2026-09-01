import { z } from "zod";

/** The only icon names that can be referenced by persisted themes or blocks. */
export const CUSTOM_BLOCK_ICON_NAMES = [
  "x",
  "check",
  "loader-circle",
  "circle-alert",
  "info",
  "lightbulb",
  "sticky-note",
  "chevron-down",
  "chevrons-right",
  "columns-3",
  "layout-panel-top",
  "search",
  "upload",
  "download",
  "link-2",
  "settings",
  "palette",
  "play",
  "square",
  "rotate-ccw",
  "bold",
  "italic",
  "heading-2",
  "list",
  "file-text",
] as const;

export const iconNameSchema = z.enum(CUSTOM_BLOCK_ICON_NAMES);
export type IconName = z.infer<typeof iconNameSchema>;
