// SPDX-License-Identifier: Apache-2.0
// Init script for browsers without a file-backed fake camera (WebKit): getUserMedia returns the capture stream of a
// canvas that plays the sequence's gray frames at 30 fps. Serialized into the page; must stay self-contained.

export function installFakeCamera(config: { url: string; width: number; height: number; frames: number }): void {
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(config.width, config.height);
  let data: Uint8Array | null = null;
  let index = 0;
  const draw = (): void => {
    if (data) {
      const size = config.width * config.height;
      const o = (index % config.frames) * size;
      for (let i = 0; i < size; i++) {
        const v = data[o + i]!;
        image.data[4 * i] = v;
        image.data[4 * i + 1] = v;
        image.data[4 * i + 2] = v;
        image.data[4 * i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      index++;
    }
  };
  void fetch(config.url)
    .then((r) => r.arrayBuffer())
    .then((buffer) => {
      data = new Uint8Array(buffer);
      draw();
      setInterval(draw, 1000 / 30);
    });
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
  const devices = navigator.mediaDevices ?? ({} as MediaDevices);
  Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
  devices.getUserMedia = async () => stream;
}
