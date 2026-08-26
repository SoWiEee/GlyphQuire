export interface Runner {
  execute(source: string, props: { height: number; network: string[]; autoplay: boolean }): void;
  stop(): void;
}
