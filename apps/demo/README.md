# LiveMira demo

[English](README.md) | [简体中文](README.zh-CN.md)

A full-screen demo of the public engine: point the camera at a sample picture and a video plays on it.

```sh
npm run dev   # builds dist/demo and serves it at http://127.0.0.1:5173/
```

On a phone, open the page over HTTPS (for example through a temporary tunnel to the local server); the camera needs a
secure context. Tap **Start**, allow the camera and point it at the chosen picture, shown on another screen or
printed.

Panels (round buttons in the corner): **Run** (start, stop, sound, retry the video), **Target and video** (a sample or
your own picture; the included, a local or an HTTPS video), **Options** (processing long edge, how the camera fills
the screen, keeping the video after a loss, frame capture), **Visualization** (recognized boundary and matched
points) and **Diagnostics** (full log switch and export). Options apply at the next start. Defaults: processing long
edge 640, 500 ms grace, canvas frame capture, the camera filling the screen.

The demo uses only the public engine (`livemira-engine.mjs`, loaded at run time) and loads the tracking visuals module
only when a drawing is switched on. Everything runs on the device; nothing is uploaded. Sample pictures: see
[CREDITS](assets/CREDITS.md).
