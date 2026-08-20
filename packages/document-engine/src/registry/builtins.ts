import { BlockRegistry, registerBuiltin } from "./registry.js";
import { calloutBlock } from "./blocks/callout.js";
import { stickyBlock } from "./blocks/sticky.js";
import { toggleBlock } from "./blocks/toggle.js";
import { tabsBlock, tabBlock } from "./blocks/tabs.js";
import { columnsBlock, columnBlock } from "./blocks/columns.js";
import { p5Block, canvasBlock } from "./blocks/runtime.js";

/** A registry preloaded with every v0.1 built-in block definition. */
export function createRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const def of [
    calloutBlock,
    stickyBlock,
    toggleBlock,
    tabsBlock,
    tabBlock,
    columnsBlock,
    columnBlock,
    p5Block,
    canvasBlock,
  ]) {
    registerBuiltin(registry, def);
  }
  return registry;
}
