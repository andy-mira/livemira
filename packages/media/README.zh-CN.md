# VideoSession

[English](README.md) | [简体中文](README.zh-CN.md)

`src/video-session.mjs` 拥有单个 HTMLVideoElement 的 URL、播放以及解码帧观察器。配置通过声明文件使用公开的 `MediaConfig`。在设置源之前设置 `crossOrigin`，默认 muted/loop/inline，暂停时保留播放进度时间，仅在请求时重新开始。`stop` 释放 src/srcObject 和回调；`dispose` 还会移除错误监听器且是幂等的。分配的媒体流会被解除关联，但其媒体轨道归调用方所有；测试夹具会显式停止其生成器轨道。

当 requestVideoFrameCallback 不可用时，`observeFrames` 返回 false；不会将 rAF 时间戳错误标记为新解码的帧。在这种情况下，CSS 视频仍会以原生方式合成。回调次数和 mediaTime 是视频呈现诊断信息，而非相机观测时间或运动到光子（motion-to-photon）测量值。

播放拒绝和生命周期竞态测试使用注入的伪视频（fake video）。它们无法证明浏览器自动播放策略、静音、编解码器/CORS 兼容性或解码器资源基线。该模块没有第三方媒体或运行时依赖。

循环播放：`MediaConfig.loop`（默认为 true）设置原生 `video.loop`；false 让片段播放结束并保持结束状态，从不倒回。推荐使用原生循环播放。由于曾在手机上观察到播放接近有限片段结尾时停止（decodedFrames 和 currentTime 保持不变，`paused=false`，未触发 `ended`），因此处于活跃状态的循环会话还会运行一个 400 ms 的定时器，该定时器仅在具有已知有限时长的片段接近结尾、且连续两次轮询中 currentTime 和解码帧计数均未变动时才会生效。仅当元素处于暂停/已结束状态时，它才会倒回到 0 并调用 `play`。仅当处于活跃状态、循环播放、实际已结束且处于当前片段结尾时，`ended` 事件才会执行相同操作。片段中间变慢从不倒回；在 3 次恢复且未观察到进展后，会话将停止尝试。播放拒绝使用常规失败回调且不进行重试。媒体错误、`pause`、`stop`、`configure` 和 `dispose` 会取消该定时器，因此宽限期到期的暂停后不会跟随恢复操作。诊断信息报告 `loop`、`ended`、`loopRecoveries`；渲染器媒体遥测将这些以及 `duration` 作为可选字段添加，以便旧日志保持兼容。这属于兼容性回退机制，而非已证明的 Safari 根本原因；手机上的表现未经确认。

微信播放恢复：`MediaConfig.wechatPlaybackRecovery`（默认为 `'auto'`，或 `'off'`）。原生 `video.play()` 始终在调用方的调用栈中首先被调用。仅当它被拒绝并抛出 `NotAllowedError`，且仅对于从视频自身的 `ownerDocument.defaultView.navigator` 读取的 iOS (iPhone/iPad/iPod) 微信 (`MicroMessenger`) 用户代理，`src/wechat-playback.mjs` 会发起一次 `WeixinJSBridge.invoke('getNetworkType')`，其回调会同步调用当前视频的 `play()`。该桥接从同一个 window 读取（若不存在则等待 `WeixinJSBridgeReady`）；就绪/回调等待受单个 1500 ms 定时器的限制，不进行轮询、重试、预加载或元素复用。`play`、`pause`、`stop`、`configure`、`dispose`、原生媒体错误、隐藏页面/`pagehide` 或较新的 `play` 会取消挂起的操作：定时器和监听器被移除，被取消的 `play` 迅速以 `false` 完成返回，迟到的就绪/回调事件绝不会播放，并且拒绝会被消费。最终失败会保留现有的 `playbackBlocked`/`error` 事件，因此直接手势 `resumeFromGesture`/`retryFromGesture` 仍为回退方案。没有新增事件类型。诊断信息（以及渲染器 `mediaState.media`）增加了可选的 `playbackPath`（`'native'|'wechat-bridge'|null`，即最近发起的尝试，并非成功证明）和 `wechatRecoveryAttempts`；`playing`、时间和解码帧仍为真实依据。依据：一次 iPhone 微信 8.0.79 探测，其中第三个媒体的原生播放被拒绝，随后桥接回调启动了实际播放。这是该上下文恢复技巧的证据，而非有保证的宿主 API；在其他微信版本/设备上的行为未经验证，并且这些 Node 测试使用模拟对象，不能证明真实设备的行为。

通过现有的 SDK 接口控制循环播放；无需 UI：

```ts
engine.setTargetMedia('bird-01', { url: videoUrl, loop: true }); // default: repeat
engine.setTargetMedia('bird-01', { url: videoUrl, loop: false }); // play once
```

调用 `setTargetMedia` 会替换媒体配置；更改循环设置时请附带 URL。

首个可呈现帧（2026-10-12）：`awaitPresentableFrame(callback)` 是针对*当前*媒体请求的单次就绪监听，供渲染器的加载遮罩和圆形展开使用。它绝不仅将 `loadedmetadata`/`canplay`/`readyState` 视为就绪。在使用 `requestVideoFrameCallback` 时，仅当元素同时具有 `readyState >= 2`、非零的 `videoWidth`/`videoHeight` 且无错误时，第一个呈现帧回调才生效（`signal: 'video-frame-callback'`；载荷为 `mediaTime`、`presentedFrames`、`decodedFrames`）。在缺少该 API 的情况下，保守的回退机制（`signal: 'time-progress'`）每 100 ms 轮询一次，并需要相同的检查、处于未暂停状态的元素、在两次连续轮询中 `currentTime` 严格递增且超过开始监听时的值，以及当 `getVideoPlaybackQuality` 报告有限计数值时解码帧数多于开始时的帧数；它最多可在真实第一帧之后约两次轮询时触发，绝不会早于真实第一帧。较新的调用、`stop`、`configure`、媒体错误和 `dispose` 会取消监听（代际 epoch 使陈旧的宿主回调失效，且宿主回调/定时器被取消）；`pause` 不会取消，因此隐藏的请求会以相同的监听恢复。`retryFromGesture` 会重新加载元素（readyState 降为 0），因此调用方必须在其之后重新装配监听；渲染器会执行此操作。流式传输无需完全下载：如前所述使用 `preload='metadata'` 加上 `play()`，且无需等待 `canplaythrough` 或下载结束。Node 测试使用模拟对象，证明的是所有权/取消规则，而非真实解码。
