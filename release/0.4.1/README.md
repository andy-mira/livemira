# LiveMira 0.4.1

[English](README.md) | [简体中文](README.zh-CN.md)

Image-target AR in the browser, with on-device recognition, tracking, video overlays and an optional camera UI.

| Directory | Contents |
| --- | --- |
| `files/` | Readable and minified ES modules, standalone Worker and TypeScript declarations. |
| `npm/` | Five offline npm package archives. |
| `demo/` | Static demo site and licensed sample assets. |
| `documentation/` | Engine, UI, extension and migration guides. |

Copy modules from `files/` into your application, or install the package archives from `npm/`:

```sh
npm install ./npm/livemira-engine-0.4.1.tgz ./npm/livemira-ui-0.4.1.tgz
```

See the [engine guide](documentation/engine.md), [camera UI guide](documentation/ui.md),
[changes](CHANGELOG.md) and [source](../../README.md).
Serve `demo/` over HTTPS or localhost; camera access requires a secure context and user permission.

Physical-device compatibility is not established for the camera UI. Android and in-app browsers remain unverified.
Validate camera, playback and orientation behavior on your supported devices. Fast motion can lose tracking;
rotation can leave the video overlay visible for about one extra frame.

`release-manifest.json` records module build identifiers and file hashes. `SHA256SUMS` covers all other release
files, including the manifest. Verify with `shasum -a 256 -c SHA256SUMS` from this directory.

Apache-2.0; see [LICENSE](LICENSE), [NOTICE](NOTICE) and [sample credits](demo/assets/CREDITS.md).
