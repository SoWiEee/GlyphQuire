interface Runner {
  execute(source: string, props: { height: number; network: string[]; autoplay: boolean }): void;
  stop(): void;
}

export function createCanvasRunner(container: HTMLElement): Runner {
  let animationId: number | null = null;
  let canvas: HTMLCanvasElement | null = null;

  return {
    execute(source, props) {
      canvas = document.createElement("canvas");
      const width = container.clientWidth || 400;
      canvas.width = width;
      canvas.height = props.height;
      container.appendChild(canvas);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const userCode = new Function("canvas", "ctx", "width", "height", source);
      userCode(canvas, ctx, width, props.height);
    },

    stop() {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
      if (canvas) {
        canvas.remove();
        canvas = null;
      }
      container.innerHTML = "";
    },
  };
}
