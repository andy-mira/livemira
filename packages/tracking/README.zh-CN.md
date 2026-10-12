# 跟踪

[English](README.md) | [简体中文](README.zh-CN.md)

`src/index.ts` 导入 `@livemira/contracts` 0.1.0 并导出 `createTrackingPipeline(recognize): VisionPipeline`，外加两个可选加入的变体（`createHybridTrackingPipeline`、`createSubpixelTrackingPipeline`）。注入的异步 `recognize` 回调接收 `(FramePacket, readonly TargetBundle[], AbortSignal)` 并返回 `readonly RecognitionObservation[]`。它必须在完成返回之前结束所有借用图像的工作。该管线不拥有回调或后端资源，且从不释放 SDK 拥有的帧；集成者拥有回调和后端处置的所有权。不存在默认或模拟识别器。回调错误会向上传播。

```ts
import { createTrackingPipeline } from '@livemira/tracking';
import { CpuRecognizer } from '@livemira/recognition';
const recognizer = new CpuRecognizer(); // reload it whenever the target set changes
const pipeline = createTrackingPipeline(async (frame, targets, signal) =>
  (await recognizer.recognizeFrame(frame, { signal })).observations);
// Supply pipeline to createEngine({ source, pipeline, renderer }).
```

默认管线在每个全新帧上执行原始图像识别，而非光流传播。它拒绝没有显式 `original-target` 来源或与目标 `algorithmVersion` 不匹配的观测。输入需要映射的单调时间和 `imageIdentity`；它绝不使用到达时间代替观测时间。最多保留 128 个近期内容标识。目标数组在加载时进行克隆。并发处理调用将被拒绝；reset 和 dispose 会取消并等待未完成的回调工作。返回的结果与内部状态脱钩。

## 确认与质量门控

所有工厂函数均接受可选的第二个参数 `{ maxObservationGapUs: 1000000 }`。默认值允许在同一目标的有效原始观测之间存在 1 秒间隔，以及 2 秒的总计三次观测时间窗口；显式指定的值被限制在 125000..2000000 us 之间（总窗口为该值的两倍）。仍需要至少三个全新独立的观测且首末观测跨度至少 50 ms。匹配失败、错误或目标变更都会中断捕获（acquisition），且重复内容不会推进捕获。

第一个有效帧仅进入 ACQUIRING（捕获中），此时几何为 null 且 `quality.measured=false`。门控条件：>= 8 个内点，比率 >= 0.6，重新计算的目标凸包覆盖率 >= 0.2，重新计算的重投影 RMS <= 2 px，有限非奇异 H，不跨越目标地平线，且投影面积 >= 16 px²。识别确认与渲染新鲜度是分开的：即使经过确认的最新结果也会保留 `predictionExpiresAtUs = observationTimeUs + 100 ms`，而缓慢的结果可能已经过期且必须保持隐藏。这些模块参数是临时设定的，并非生产阈值。

活跃目标不能直接切换。在没有新的经过验证的同一目标绝对观测的情况下，自上次可靠测量起经过 100 ms 后进入 LOST（丢失）并需要重新捕获。间隔后新的经过验证的绝对观测可以恢复测量的 TRACKING（跟踪中）；它绝不延长旧的预测几何。在处理继续进行的同时，SDK 必须独立隐藏过期的输出。渲染边缘使用 width/height；特征采样限制在 width-1/height-1 之内。即使提供了目标尺寸，位姿也保持为 null：未实现经过校准的分解。

## 可选加入变体

`createHybridTrackingPipeline(recognize)` 在原始图像确认后保留一份拥有的标准 gray8 快照（<= 1M 像素）以及 <= 64 个配对点。它使用相同的质量门控执行点跟踪和鲁棒的目标空间 H 重新拟合，自上次接受绝对观测起 >= 200 ms 以及在任何光流失败时重新匹配原始图像，并且只有原始匹配才能进行捕获或重新捕获。光流测量保留绝对校正年龄并使用原因 `point-track-measured`，而预测保持仍未测量。光流观测保留目标的 `algorithmVersion` 并显式使用 `correspondenceOrigin = 'previous-frame'`；`sourceFrameId` 绑定上一个测量的输入。点运算符 ID 与目标描述符 ID 保持区分。实测收益参差不齐；保持其为可选加入。

`createSubpixelTrackingPipeline(recognize)` 使用算法 `d-gauss5-znlk13-fb/0.2.0`，导出为供带有拥有的零层灰度副本的计算后端 CPU 运算符使用的 `subpixelPointOperator`：在高斯 5 浮点金字塔上进行 13x13 归一化光度 Lucas-Kanade、双线性亚像素采样和正反向检查，带有 QR 鲁棒平面估计器和空间分散支撑。绝对校正具有严格的 200 ms 最大值，在低覆盖率或 RMS 时缩短至 100 ms；失败或微弱的光流立即请求原始匹配。点不能重置绝对时钟，预测保持在 100 ms 时过期，且不应用输出平滑。在合成测试中，其误差长尾表现优于整数跟踪，但精度和 p95 耗时总体上并未超越默认值，因此它不是默认选项。

`src/cpu-points.ts` 使用现有的 `ComputeBackend` 值有效载荷类型独立实现 `trackGrayPoints`：最多三个 box/floor 金字塔层级，每层 ±3 像素内的 7x7 块搜索，纹理方差、SSD 和歧义性检查，正反向误差 <= 1 px，整数输出。硬性限制：每个输入 1M 像素和 256 个点。`cpuPointOperator` 和 `CPU_POINT_ALGORITHM` 可以提供给 `new CpuComputeBackend({ algorithmVersion: CPU_POINT_ALGORITHM, trackPoints: cpuPointOperator })`；使用原始零层灰度副本，而非后端的 Gaussian 金字塔，且绝不将识别描述符标记为此算法 ID。算术运算是同步的，在调用边界检查取消信号。默认管线不使用它。

## 实验性原型

`experimental/*.mjs` 是一个数值与控制原型（具有确定性四点共识采样的归一化单应性估计，一个小型状态机），并非冻结的公开 API；它不导入任何识别、计算、SDK、WebAssembly 或浏览器模块。其设计：显式会话重置；陈旧的会话和帧以及倒退或非有限的时间戳均被拒绝；ACQUIRING 隐藏几何；低质量或另一个目标进入带有零阶保持的 LIMITED，这是预测且绝非可靠覆盖；在年龄 >= 100000 us（包括仅定时器的 tick）时进入 LOST 并隐藏 H。带有固定 256 次试验种子共识循环的正规方程最小二乘法是一项小型 CPU 实验，不能替代生产级 SVD/RANSAC。输出平滑（alpha 0.35）减少了合成静态噪声，但在 30 Hz 下将恒速运动延迟了约 61.9 ms，因此未启用平滑。

## 构建

在 `npm ci` 之后，从代码仓库根目录运行：`npm run build`（根 TypeScript 构建包含此软件包），或运行 `node node_modules/typescript/bin/tsc -p packages/tracking/tsconfig.json` 进行单独类型检查。

## 出处

原创代码；未复制、链接或分发任何第三方源码。公开计算机视觉项目（OpenCV、MindAR、OpenVINS）仅作为阅读材料参考，未移植其任何实现。
