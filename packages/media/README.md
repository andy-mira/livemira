# @livemira/media

Video playback session: playback, muting, gesture retry, loop recovery, first presentable frame detection and playback recovery adapters.

## Dependencies

`@livemira/contracts`

## Public API

Private workspace package, bundled into `@livemira/engine`.

- `VideoSession`: one media element's playback, muting, gesture retry, loop-stall recovery and first presentable frame.
- `PlaybackRecovery` adapters; `wechatIosBridgeRecovery` (the default list) retries a blocked play once through the iOS
  WeChat bridge.
- Types: `MediaConfig`, `MediaState`, `MediaSnapshot`, `MediaPresentationTelemetry`.
