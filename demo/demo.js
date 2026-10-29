// SPDX-License-Identifier: Apache-2.0
// LiveMira demo: the camera UI over the single-file engine, four sample photos and one video. Choices can also be
// given in the address: ?profile=hawk&scale=0.5&fit=contain&lang=en.

import { mountArCamera, UI_VERSION } from './livemira-ui.min.mjs';

const params = new URLSearchParams(location.search);
const landing = document.getElementById('landing');
const choose = (id) => {
  const select = document.getElementById(id);
  if (params.has(id)) select.value = params.get(id);
  return select;
};
const profile = choose('profile');
const fit = choose('fit');
const scale = choose('scale');
const lang = choose('lang');
document.getElementById('version').textContent = UI_VERSION;

const photos = ['bird-01', 'forest-03', 'mountain-01', 'ship-01'];
// Chromium builds without H.264 play the WebM copy.
const video = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')
  ? 'assets/demo-video.mp4'
  : 'assets/demo-video.webm';

let camera = null;
document.getElementById('start').addEventListener('click', () => {
  if (camera) return;
  landing.hidden = true;
  camera = mountArCamera(document.body, {
    loadEngine: () => import('./livemira-engine.min.mjs'),
    targets: photos.map((id) => ({ id, photo: `assets/${id}.png`, video })),
    engineOptions: { profile: profile.value, camera: { fit: fit.value, processingScale: Number(scale.value) } },
    locale: lang.value,
    isAutoStart: false,
    onExit: () => {
      const closing = camera;
      camera = null;
      void closing?.destroy().then(() => {
        landing.hidden = false;
      });
    },
  });
  // Started from the tap: the camera prompt and playback have the user's gesture.
  camera.view.start();
  window.__livemira = camera;
});
if (params.has('autostart')) document.getElementById('start').click();
