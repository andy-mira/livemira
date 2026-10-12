# CPU 识别基线

[English](README.md) | [简体中文](README.zh-CN.md)

`CpuRecognizer` 在 CPU 上查找 gray8 帧中的图像目标。它仅生成原始目标的 `RecognitionObservation` 候选，从不生成跟踪状态或 SDK 事件；确认与重新匹配调度属于 tracking 软件包。

## 算法

同一个 `CpuRecognizer` 接受统一的传统目标名录或统一的 `c-oriented-brief256-v2` 目标名录；版本混用将予以拒绝。传统目标使用 `m0-harris-brief256-v1`（每层贪婪选择）或 `m0-harris-anms-brief256-v1`（ANMS 选择）。若要更改算法，必须重新编译目标；编译器默认项仍为传统算法。参见[目标编译器 README](../target-compiler/README.md)。

对于传统目标，全局未命中会获得一次半倍频程（half-octave）重试，而不会更改已保存的描述符或几何阈值。`legacyScaleSearch: false` 会跳过该重试（仅供诊断比对）。

```ts
const recognizer = new CpuRecognizer();
await recognizer.loadTargets(targets); // 1..10 unique IDs; validates and snapshots atomically
const batch = await recognizer.recognizeFrame(frame, { signal });
// The tracking pipeline consumes batch.observations. Ambiguous target evidence yields an empty list.
recognizer.dispose();
```

`recognizeFrame` 借用带有 `rotation=0` 和 `mirrored=false` 的实时打包 gray8，保留 `sessionId` 和 `frameId`。它不会释放输入。`recognizeGray(image, { sessionId, frameId }, { roi, signal })` 可供回放和计算后端调用方使用。ROI 是一个标准图像矩形；它过滤候选中心，保留完整图像坐标，并仍会构建完整金字塔。它**并不**意味着优化过的裁剪图像内核。

## 匹配与几何

两个算法族均通过 `matchPacked` 在 8 字打包描述符上运行匹配器（针对每个目标进行缓存，每帧轮次打包一次）。它在输出上与历史的按字节 `matchFeatures` 完全相同，后者保留在 `experimental/` 中作为差分基准（differential oracle）。

匹配器：互为最近邻（reciprocal nearest neighbors），汉明距离 <= 64，严格满足最佳/次佳比率 < 0.75；平局拒绝。几何：带有确定种子的 256 次迭代 RANSAC，采用归一化 8 未知数最小二乘法，阈值 3 个图像像素，>= 12 个内点，比率 >= 0.35，凸包覆盖率 >= 0.08，重新拟合，无奇异性、反射或目标域地平线。公开覆盖率为 凸包 / (width * height)，并且公开单应性会对照目标边缘角点进行检查。退化或微弱的观测会被拒绝；不捏造默认的恒等观测。最高目标支持度相等或接近相等（次佳 >= 最佳的 85%）属于歧义并会被抑制。这是一种保守的启发式方法，并不能杜绝任意相似图像带来的误判。

## 加载、限制与取消

目标加载会拒绝不受支持的编译器或算法以及不兼容的预处理。CPU 特征必须从规范的未经平滑处理的 gray8 开始：此识别器使用 box2 金字塔和 box3 层平滑，而非计算后端的 Gaussian5 预处理。后端切换不能将描述符重新标记为兼容。加载失败会保留先前活跃的目标集。较新的加载或 dispose 会使挂起的加载完成失效。最多 10 个目标快照以及每次提取最多 512 个特征限制了工作量；暴力目标检索为 O(targets * targetFeatures * frameFeatures * 32)。未实现由粗到精的检索。

在工作之前以及在目标之间会检查取消信号。算术运算在调用方的 JavaScript 线程上同步进行，因此通过事件循环交付的 abort 无法打断它；硬取消通过终止托管该识别器的 Worker 来完成。Promise 完成后不会留下未决的帧读取或 GPU 工作。请勿在相机帧率下在 UI 线程上运行此基线；SDK 将其托管在 Worker 中。

与 tracking 软件包的最小集成：实例化一次识别器，在目标集更改时重新加载它，然后将 `(frame, targets, signal) => recognizer.recognizeFrame(frame, { signal }).then(batch => batch.observations)` 注入到 `createTrackingPipeline` 中。回调必须确保其缓存的目标集与 `targets` 匹配；在每一帧都进行加载会增加本可避免的哈希与复制开销。该模块本身从不自行触发全局识别。

## 构建

在 `npm ci` 之后，从代码仓库根目录运行：

```sh
node node_modules/typescript/bin/tsc -p packages/recognition/tsconfig.json
```

对该识别器的测量受限于获取测量值时的环境；此处不作出任何手机性能或生产就绪声称。识别算法均为原创实现（出处参见目标编译器 README）。
