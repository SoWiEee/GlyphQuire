import p5 from "p5";
import type { Runner } from "../types.js";

export function createP5Runner(container: HTMLElement): Runner {
  let instance: p5 | null = null;

  return {
    execute(source, props) {
      const userSetup = new Function("sketch", source);

      instance = new p5((sketch: p5) => {
        sketch.setup = () => {
          sketch.createCanvas(container.clientWidth || 400, props.height);
          try {
            userSetup(sketch);
          } catch (err) {
            sketch.remove();
            throw err;
          }
        };
      }, container);
    },

    stop() {
      if (instance) {
        instance.remove();
        instance = null;
      }
      container.innerHTML = "";
    },
  };
}
