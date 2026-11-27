// Whether this page can get a hardware-accelerated WebGL context.
//
// Without GPU compositing (software rendering, a blocklisted GPU, some remote desktops) the
// browser reads every WebGL frame back to the CPU on the main thread. Measured on 2222 with
// 16 sessions: that readback took most of the renderer main thread, and xterm's DOM renderer
// was cheaper. A context asked for with failIfMajorPerformanceCaveat is refused in exactly
// that case, so one such request per page answers the question.
// @req PERF-BGSTAB-026

interface ProbeContext {
  getExtension(name: string): { loseContext(): void } | null;
}

interface ProbeCanvas {
  getContext(type: 'webgl2', attributes: { failIfMajorPerformanceCaveat: true }): ProbeContext | null;
}

/** Returns a function that answers once, from one probe context, and remembers the answer. */
export function createWebglHardwareProbe(createCanvas: () => ProbeCanvas): () => boolean {
  let answer: boolean | null = null;
  return () => {
    if (answer !== null) return answer;
    const context = createCanvas().getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    answer = context !== null;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return answer;
  };
}

/** The page-wide probe. */
export const isWebglHardwareAccelerated = createWebglHardwareProbe(
  () => document.createElement('canvas') as unknown as ProbeCanvas,
);
