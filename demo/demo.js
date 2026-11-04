// SPDX-License-Identifier: Apache-2.0
// LiveMira demo: the camera UI over the single-file engine, four sample photos and one video. Choices can also be
// given in the address: ?profile=hawk&scale=0.5&fit=contain&lang=en.

import { mountArCamera, UI_VERSION } from './livemira-ui.min.mjs';

// The landing page shows no choices; defaults are used. Each can still be overridden from the address:
// ?lang=zh-CN for Chinese (?profile=hawk&scale=0.5&fit=contain also work)
const params = new URLSearchParams(location.search);
const landing = document.getElementById('landing');
const pick = (id, fallback) => (params.has(id) ? params.get(id) : fallback);
const profile = pick('profile', 'swift');
const fit = pick('fit', 'cover');
const scale = pick('scale', '1');
const lang = pick('lang', 'en');
document.getElementById('version').textContent = UI_VERSION;

const photos = [
  { id: 'target', name: 'couple', mp4: 'assets/video.mp4', webm: 'assets/video.webm' },
  { id: 'demo-memory', name: 'memory', mp4: 'assets/demo-memory.mp4', webm: 'assets/demo-memory.webm' },
];
// Chromium builds without H.264 play the WebM copy. Both copies keep their audio track; playback starts muted
// (autoplay policy) and the UI sound button unmutes.
const canH264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"');

let camera = null;
const start = () => {
  if (camera) return;
  landing.hidden = true;
  camera = mountArCamera(document.body, {
    loadEngine: () => import('./livemira-engine.min.mjs'),
    targets: photos.map((p) => ({ id: p.id, photo: `assets/${p.id}.png`, video: canH264 ? p.mp4 : p.webm })),
    engineOptions: { profile, camera: { fit, processingScale: Number(scale) } },
    locale: lang,
    isAutoStart: false,
    onExit: () => {
      const closing = camera;
      camera = null;
      void closing?.destroy().then(() => {
        landing.hidden = false;
      });
    },
  });
  camera.view.start();
  window.__livemira = camera;
};
document.getElementById('start')?.addEventListener('click', start);
// No landing gate: the page scans right away. A landing screen with a start button would cost a tap; browsers
// allow getUserMedia without a gesture, and autoplay starts muted, so the first user tap is the sound button.
start();
