# 相机运行时

[English](README.md) | [简体中文](README.zh-CN.md)

无依赖的 ES 模块，带有导入 `@livemira/contracts` 0.1.0 的类型化入口。不存在与之冲突的 FramePacket 定义。Node 用于可重现的生命周期测试；浏览器相机捕获使用 getUserMedia、静音的 playsInline 视频、requestVideoFrameCallback 以及经过测试的带有 ImageBitmap 回退的 VideoFrame 快照。仅凭 API 的存在从不能证明捕获成功。

## SDK 集成

```ts
import { CameraFrameSource, ReplayFrameSource } from '@livemira/camera';
const source = new CameraFrameSource({
  camera: { width: 1280, height: 720, facingMode: 'environment' },
  onEvent(event) { /* Handle errors, geometryChanged, clockMapping and suspended. */ },
});
// Pass source to the SDK's createEngine({ source, pipeline, renderer }).
```

CameraFrameSource 和 ReplayFrameSource 实现了规范的 FrameSource。SDK 提供 sessionId 和 AbortSignal；所有权在 onFrame 时转移给 SDK。仅 SDK 负责排队和释放转移的帧。stop/dispose 从不关闭已转移的图像。SDK 在释放前必须等待所有 CPU/GPU 借用方。即使 getUserMedia 权限仍处于挂起状态，Abort 也会迅速结束尚未完成的 start 处理；随后授予的媒体流会立即停止。

两个 SDK 源均实现了 nowSessionUs()：活跃的 MediaClock 到达时钟，或在停止/挂起时为 null。预测过期必须与此同一个会话时钟进行比较，绝不能与全局 performance.now 比较。这包括交付给 SDK 之前用于捕获/复制的时间。

对于独立使用，CameraRuntime 和 ReplaySource 接受 `consume(frame): void | Promise<void>`。它们的队列允许一个正在处理的帧和一个候选帧。较新的候选帧会释放其前身。Promise 完成即结束借用；GPU 消费者必须自行等待 GPU 完成。stop 会释放候选帧、使回调失效，并保留活跃借用直至其完成。消费者也必须拒绝旧会话的结果。未决的消费者可有意保持 dispose 挂起；强制释放是不安全的。

CameraRuntime 使用全新会话管理独立隐藏/恢复。CameraFrameSource 在隐藏时停止并发出 `{type:'suspended', requiresRestart:true}`。在可见性恢复后，SDK 集成必须停止/重新启动引擎，以便其管线、渲染器和源共享**新**会话。使用 `await engine.stop(); source.configureCamera({deviceId}); await engine.start(container)` 切换设备。直接调用 `CameraRuntime.switchCamera` 仅供独立使用。错误包括权限拒绝、轨道结束、快照失败和源时钟重置。重置会停止实时捕获并需要全新会话。没有自动权限重试。

## 帧、几何与时钟

- 像素句柄公开规范的 kind/data/released/release。原生解码器存储开销未知；VideoFrame 不宣称零拷贝。stats.bitmapCopies 统计实际成功的 ImageBitmap 快照数量，而非隐藏的浏览器/GPU 分配。
- 呈现帧计数器加上媒体时间戳可抑制重复回调。较旧的回调回退方案使用视频播放帧计数器，绝不使用动画回调时间作为观测。缺少 API 的浏览器将拒绝捕获。此回退方案仍需真机验证。
- FramePacket 尺寸描述实际快照。几何默认采用 640 像素长边，输入旋转为 0：浏览器显示的屏幕方向已预先应用。请勿盲目使用屏幕方向再次旋转。输入镜像表示**像素**是镜像的；仅选择前置摄像头并不意味着设置了镜像。
- `geometryChanged` 提供规范的 FrameGeometry。矩阵映射像素**边缘**，采用行优先列向量。裁剪/去镜像/旋转/缩放只合成一次。视口输出为 CSS 像素；DPR 是用于帧缓冲区转换的元数据。`updateGeometry` 提供处理尺寸、适应模式、显式裁剪、旋转或镜像。在具有默认浏览器稳定化和 previewContainer 的情况下，其实时边界矩形和浏览器 DPR 会自动提供 CSS 尺寸；当稳定化被禁用时，将保留手动 CSS 尺寸管理。下游预处理必须实际应用 H_standardFromInput；此软件包不会暗中光栅化规范像素。
- 校准回调接收设备设置（包括公开时的缩放比例）、图像尺寸和几何结构。发生变更会重新计算 calibrationId；无匹配项则返回 null。不存在虚构的焦距或精确校准声称。浏览器缩放/对焦元数据缺失需要独立的校准验证。
- 曝光时间和不确定性为 null。MediaClock 将第一个媒体时间戳与接收时间对齐，单独发出偏移量，并设置带有**未知** clockMappingUncertaintyUs 的 mappedObservationTimeUs。这是近似的接收对齐，绝不是曝光或运动到光子（motion-to-photon）对齐。未实现漂移估计。加速步进的回放应注入兼容的虚拟 nowUs 时钟。

ReplayFrameSource 是手动步进的，而非编码视频解码器：await start，然后 push(sessionId, sample)。每次 push 即使被拒绝也会转移所有权。CPU 缓冲区必须是紧密打包的 rgba8/bgra8/gray8，且具有精确的字节长度。调用方负责解码授权媒体、控制时序并提供用于重复内容检测的 imageIdentity。start 会创建/重置时钟；stop 会拒绝迟到的解码交付。原生图像句柄连同其显式格式一并被接受。

## 构建与类型检查

在 `npm ci` 之后，从代码仓库根目录运行：

```sh
node node_modules/typescript/bin/tsc -p packages/camera/tsconfig.json
node packages/camera/examples/replay.mjs
```

相机行为因设备而异。生命周期行为由合成 Node 测试覆盖；该软件包仅通过 iPhone 浏览器 Demo 集成在真实硬件上进行了演练，其他设备均为试验性质。Android 相机权限、撤销、对焦/缩放、长期运行资源稳定性、帧率步调和发热表现均未确立。

## 出处

原创实现。未合并任何第三方源码、运行时软件包、模型或示例媒体，且未重新分发任何规范或文档文本。测试夹具（合成字节、角点坐标）均为本项目原创编写。

## 默认方向与视口稳定化

`CameraFrameSource({previewContainer})` 在浏览器中默认启用稳定化。屏幕方向信号会立即遮罩所拥有的相机区域。SDK 订阅 `onViewportTransition`，即刻强制隐藏覆盖层（即使它位于单独的同级容器中），在适当时如实发出 `targetLost`，丢弃旧的工作，并在当前借用方完成处理后在同一管线/会话中重置跟踪。它保留可用的相机流和 Worker，并在新捕获的帧上恢复运行。这不同于后台挂起，并且对于常规过渡不会发出 `error` 或 `suspended`。

该源在捕获时测量预览容器，并观察其尺寸、浏览器/视觉视口以及视频固有尺寸调整（intrinsic resize）。默认门控需要具有相同捕获几何结构的连续两个全新帧，以及 100 ms 的无变动几何结构。方向信号还会额外等待固有尺寸发生变化或等待长达 400 ms；某些浏览器在旋转后仍保留相同的传感器尺寸。这是对固有方向的有界等待，而不是单独恢复显示的超时。随后的视口/固有变化会重新触发门控。尺寸为零的容器保持门控状态。绑定到帧的几何结构同时驱动预览和覆盖层；屏幕角度绝不会作为另一层像素旋转来应用。

保持预览和覆盖层容器具有响应性，且具有相同的原点和尺寸（支持同级节点）。移除停止/重新启动引擎或手动门控源/渲染器的应用程序 resize 处理程序。后台运行、权限失败、轨道结束、停止和处置均保留其既定的生命周期行为；有效流的复用仅限于普通的视口过渡。这些规则并不能使被拒绝的浏览器播放权限成功：现有的原生优先静音播放和有界的 iOS 微信恢复保持不变，并且最终的拒绝会被如实报告。

可选的 `viewportStabilization` 对象接受 `stableFrames`、`quietMs` 和 `orientationIntrinsicWaitMs`；默认值分别为 2、100 和 400。值必须是有限非负毫秒数和正整数帧数。`viewportStabilization:false` 会禁用默认门控，并为需要的集成保留显式 CSS 几何管理。初始相机设置仍使用常规的 start/permission API。没有可选过渡钩子的自定义 FrameSource 保留其现有行为。引擎中没有添加任何特定于应用程序的测试控件或 UI 按钮。
