// SPDX-License-Identifier: Apache-2.0
// Probe page for the baseline (LiveMira 0.4.1 release engine) on the same fake camera, for main-thread comparison.

interface BaselineModule {
  compileGrayTarget(
    image: { widthPx: number; heightPx: number; data: Uint8Array },
    options: { targetId: string },
  ): Promise<unknown>;
  createEngine(options: { container: HTMLElement }): {
    setTargets(entries: readonly { target: unknown }[]): Promise<void>;
    start(): Promise<void>;
    on(type: string, listener: (event: { result?: { frameId: number } }) => void): () => void;
  };
}

const record = {
  info: null as Record<string, unknown> | null,
  error: null as string | null,
  updates: 0,
  readyMs: null as number | null,
  firstPoseMs: null as number | null,
  results: [] as unknown[],
  presents: [] as unknown[],
};
(globalThis as unknown as { __probe: typeof record }).__probe = record;

async function main(): Promise<void> {
  // A runtime URL (not bundled): the release file is served as is.
  const url = ['', 'livemira-engine.mjs'].join('/');
  const engineModule = (await import(url)) as BaselineModule;
  const manifest = (await (await fetch('/targets.json')).json()) as { id: string; width: number; height: number }[];
  const targets = await Promise.all(
    manifest.map(async (t) =>
      engineModule.compileGrayTarget(
        {
          widthPx: t.width,
          heightPx: t.height,
          data: new Uint8Array(await (await fetch(`/targets/${t.id}.gray`)).arrayBuffer()),
        },
        { targetId: t.id },
      ),
    ),
  );
  const engine = engineModule.createEngine({ container: document.getElementById('stage')! });
  await engine.setTargets(targets.map((target) => ({ target })));
  engine.on('targetUpdated', () => {
    if (record.firstPoseMs === null) record.firstPoseMs = performance.now();
    record.updates++;
  });
  await engine.start();
  record.readyMs = performance.now();
  record.info = { capturePath: 'baseline-canvas', compositor: 'baseline-css' };
}

main().catch((error) => {
  record.error = String(error?.stack ?? error);
});
