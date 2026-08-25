import p5 from "p5";

interface Runner {
  execute(source: string, props: { height: number; network: string[]; autoplay: boolean }): void;
  stop(): void;
}

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
