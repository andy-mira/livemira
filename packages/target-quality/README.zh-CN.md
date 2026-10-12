# 目标适用性预检（可选工具）

[English](README.md) | [简体中文](README.zh-CN.md)

在交付图片之前，对图片作为图像目标的适用性进行 **0..5** 的评分。**低于 3 分建议更换图像。** 3 分或以上在真实设备上仍可能失败（光照、运动模糊、打印质量、相机、匹配器自身的限制）；该评分是一种启发式预检，不是经过校准的检测概率，不是识别保证，也不是 Vuforia 或 ARCore 评级。不应用特定于素材的调优。它独立于引擎：`packages/sdk/src/browser.ts`、Worker 或两个单文件引擎均不导入它（如果导入，引擎构建器将报错失败），并且它不需要任何依赖项、Worker、WASM 或网络。

它复用了真实的传统提取器和几何结构（`m0-harris-brief256-v1` 或显式 ANMS `m0-harris-anms-brief256-v1`，384 个特征，3 个金字塔层级，与 `compileGrayTarget` 相同），因此它测量的是引擎实际编译的内容。没有新的识别器，没有逐帧匹配。

> [!NOTE]
> 本软件包仅实现独立的评分工具。它不提供上传预览，也不提供用户界面。

## 使用方法

浏览器环境，使用 `File`/`Blob` 调用一次（在本地使用 `createImageBitmap` 和 canvas 解码；不上传或拉取任何内容）：

```js
import { assessTargetImage, analyzeTargetImage, drawTemplateFeatures } from './lm-target-quality.mjs';   // standalone file, or '@livemira/engine/target-quality/single'
const controller = new AbortController();
const result = await assessTargetImage(input.files[0], { signal: controller.signal });
if (result.recommendReplacement) alert(result.advice);             // exactly: result.score < 3
for (const reason of result.reasons) console.log(reason.severity, reason.code, reason.message);

// Or get both quality result and template feature points from the SAME extraction:
const { result: r, features } = await analyzeTargetImage(input.files[0], { signal: controller.signal });
const drawnCount = drawTemplateFeatures(canvasContext, features, { width: 320, height: 240 });
```

Node（或 Worker）环境，规范 gray8，同步执行，无浏览器 API：

```js
import { assessGrayTarget, analyzeGrayTarget } from '@livemira/engine/target-quality';    // the same standalone file; SDK-only multi-file module: '@livemira/engine/development/target-quality'
const result = assessGrayTarget({ width: 512, height: 384, data: grayBytes });   // Uint8Array, width*height bytes, row-major

// With preview points from the same extraction:
const { result: r, features } = analyzeGrayTarget({ width: 512, height: 384, data: grayBytes });
```

### 静态模板特征与实时匹配点对比

由 `analyzeGrayTarget` / `analyzeTargetImage` 返回并由 `drawTemplateFeatures` 绘制的 `features` 是**静态模板特征**：编译器仅在参考图像上提取角点特征的位置。它们与**实时匹配点**（来自相机帧匹配的内点）完全不同。模板点完全说明不了相机识别是否成功，并且 `drawTemplateFeatures` 将它们渲染为空心青色圆环，以避免与实时匹配标记混淆。

受支持的算法：`m0-harris-brief256-v1`（传统默认算法）和显式 ANMS `m0-harris-anms-brief256-v1`（显式 ANMS ID）。

结果（评分器 2.0.0 为 `webar-target-quality/2`；1.0.0 为 `webar-target-quality/1`，确定性，无时间戳）：`score`（0..5，最多保留一位小数）、`maxScore: 5`、`recommendReplacement`（严格对应 `score < 3`）、`advice`、`rawScore`（用于接近阈值情况的 3 位小数诊断；决策使用 `score`）、`scorer {name, version}`、`algorithm {version, maxFeatures, levels}`、`normalization {id, grayFormula, inputWidth/Height, width/height, scale, resampling}`、`metrics`、`subscores`、`reasons[]`、`disclaimer`。

`reasons[]` 条目为 `{ code, severity, message, metric, value, threshold }`：

| 代码 | 含义 | 阻塞条件 |
|---|---|---|
| `LOW_FEATURE_COUNT` | 角点特征过少 | < 24（v2 中 warning < 96，v1 中 < 60） |
| `LOW_COVERAGE` | 特征仅覆盖图像的一小部分 | 凸包 < 15%（warning < 35%） |
| `CLUSTERED_FEATURES` | 细节集中在少数区域 / 分散度低 | 仅 warning（v2 中分散度子分项 < 0.5） |
| `DEGENERATE_GEOMETRY` | 特征大部分沿单一方向分布（共线） | 仅 warning（v2 中条件度子分项 < 0.5） |
| `REPETITIVE_PATTERN` | 许多特征具有近乎完全相同的孪生特征 | 汉明距离 16 以内 > 35%（warning > 15%，或 32 以内 > 50%） |
| `LOW_CONTRAST` | 亮度范围（第 5..95 百分位数）低于 50 | v2 中为 info（仅报告，不计分）；v1 中为 warning |
| `WEAK_SCALE_SUPPORT` | 较粗金字塔层级特征过少 | v1 中为 warning（v2 中仅报告） |
| `LOW_RESOLUTION` | 长边低于 256 px | 仅 warning |
| `DOWNSCALED` | 输入缩小至 640 px 长边 | info |

"Blocker"（阻塞项）意味着引擎自身的 `compileGrayTarget` 诊断（`LOW_TEXTURE`、`LOW_COVERAGE`、`REPETITIVE_TEXTURE`）会在同一图像上触发；任何阻塞项都会将原始分数限制在 2.0（`BLOCKER_CAP = 2`），确保图像得分始终低于 3。

## 评分公式 2.0.0（`SCORER_VERSION = '2.0.0'`，默认）

评分器 2.0.0 评估用于稳定模板位姿拟合的五个必要几何与独特性条件，每个条件作为从 0 到 1 的线性斜坡函数：

| 子分项 | 度量指标 | 0 分对应值 | 1 分对应值 | 设计依据 |
|---|---|---|---|---|
| **support** (0.20) | 特征数量 | 24 | 192 | 可用模板特征（24 = 编译器下限，192 = 384 预算的一半） |
| **coverage** (0.20) | 凸包 / 目标面积 | 15% | 60% | 归一化凸包覆盖率（15% = 编译器最低门控） |
| **dispersion** (0.20) | 归一化协方差分散度 $(\text{var}\,u + \text{var}\,v) / (2/12)$ | 0.15 | 0.55 | 目标归一化散度（$1.0$ 为整个目标上的均匀散度） |
| **conditioning** (0.20) | 各向同性 $4\det(C) / \text{tr}(C)^2$ | 0.10 | 0.50 | 2D 协方差条件度（$1.0$ = 所有方向扩展相等，$0$ = 共线） |
| **uniqueness** (0.20) | 近似重复率（$\le 16$）与模糊匹配率（$\le 32$）中的较差者 | 35% / 60% | 5% / 15% | 重复使匹配产生歧义；$< 2$ 个特征得 0 分 |

- **等权重**：每个几何子分项的权重为 `0.2`。
- **综合公式**：`combined = 0.5 * mean + 0.5 * min(subscores)`。由于存在 `0.5 * min` 这一最弱环节项，在一个条件为 0 且其他四个条件为 1.0（mean = 0.8）的情况下，得分被限制在 $5 \times (0.5 \times 0.8 + 0.5 \times 0) = 2.0 < 3$。
- **阻塞项限制**：任何编译器阻塞项都会将 `rawScore` 限制在 `BLOCKER_CAP = 2.0`。
- **发布分数**：`score = round(rawScore, 1 decimal)`。严格满足 `score < 3` 触发 `recommendReplacement: true`。
- **公式的性质**：纯粹是一种可解释的启发式方法，**不是**带标签的校准，也**不是**检测概率。对比度范围和尺度层级在指标/原因中报告，但不再直接计分（不尝试预测远距离/小尺度外观）。

## 显式 1.0.0 复现选项（`SCORER_VERSION_V1 = '1.0.0'`）

为了复现历史报告和比对，调用方可以指定 `{ scorerVersion: '1.0.0' }`：

```js
const resultV1 = assessGrayTarget(gray, { scorerVersion: '1.0.0' });
```

在 1.0.0 中：
- 子分项：`texture` (0.25)、`coverage` (0.20)、`distribution` (0.20，有效网格单元)、`distinctiveness` (0.15)、`scale` (0.10)、`contrast` (0.10)。
- 综合公式：`combined = 0.6 * mean + 0.4 * min(subscores)`。
- 阻塞项上限：2.0。

## 归一化

灰度值为 `(77R + 150G + 29B + 128) >> 8`（引擎的亮度值）。长边大于 640 的图像缩小至 640（绝不放大）；`normalization` 记录原始和归一化尺寸及其重新采样方式：`none`、`box-area`（gray API：精确区域平均，确定性）或 `canvas-draw-image`（Blob API：由浏览器 canvas 以缩小后的尺寸绘制，与引擎的目标编译器一致，因此其重新采样由浏览器定义）。仅当 Node 和浏览器路径最终产生相同的归一化灰度像素时，它们才会给出相同的结果；浏览器的编解码器、色彩管理、EXIF 方向和重新采样可能会改变这些像素，即使对于 640 px 或更小的编码文件也是如此，因此浏览器一致性是需要针对具体环境进行检查的事项，而非保证。不合成 Alpha 通道（如引擎中一样）；EXIF 方向遵循浏览器的 `createImageBitmap` 默认行为。

## 限制、验证与错误

- 导出的辅助函数 `scoreMetrics`、`scoreMetricsV2` 和 `normalizedSize` 验证其输入：非有限或超出范围的指标、非整数或超出范围的阻塞项计数（0..16）以及无效尺寸抛出 `INVALID_INPUT`。
- 即使解码器同步中止信号或从不完成返回，中止信号也会得到响应；稍后到达的解码结果将被关闭，中止监听器会被移除。信号必须提供 `aborted`、`addEventListener` 和 `removeEventListener`。
- Gray：`Uint8Array`，带有 `data.length === width*height`；每边 32..8192 px，最多 16,777,216 像素。其他任何情况均抛出 `TargetQualityError('INVALID_INPUT')`。
- Blob：非空，最多 24,000,000 字节（`maxImageBytes` 可能会降低此限制），解码最多 16,777,216 像素（`maxPixels` 可能会降低此限制）；归一化短边必须 ≥ 32（`UNSUPPORTED_IMAGE`）。
- 选项经过验证：未知键、错误类型或超出范围的限制抛出 `INVALID_OPTIONS`；`algorithmVersion` 不是 `m0-harris-brief256-v1` 或 `m0-harris-anms-brief256-v1` 抛出 `UNSUPPORTED_ALGORITHM`。
- `scorerVersion` 必须是 `'2.0.0'` 或 `'1.0.0'`。
- `TargetQualityError.code`：`INVALID_INPUT`、`INVALID_OPTIONS`、`UNSUPPORTED_ALGORITHM`、`IMAGE_TOO_LARGE`、`UNSUPPORTED_IMAGE`、`UNSUPPORTED_ENVIRONMENT`、`DECODE_FAILED`。中止以信号的原因（一个 `AbortError`）拒绝。
- 在第一个 `await` 之前读取一次选项；Blob 是不可变的。解码的 `ImageBitmap` 在成功、错误和中止时均被关闭，canvas 予以释放，包括在中止后到达的位图。
- 声明是自包含且严格的（`lm-target-quality.d.mts`；它们使用 DOM `Blob`、`AbortSignal` 和 `File` 类型，因此消费者需要 `lib: ["DOM"]`）。

## 构建、测试与评分脚本

```
npm run build                                            # tsc + dist/target-quality-single/lm-target-quality.{mjs,d.mts,audit.json}
node scripts/release/build-target-quality.mjs --out-dir <new absolute dir>
node --test --test-isolation=none tests/quality/standalone.test.mjs
```

## 未覆盖范围

这不是设备测试：此处没有任何内容用于测量运动、光照、手机相机或匹配器针对实时帧的比率测试。未对透视、部分遮挡和打印质量建模。阈值是启发式的，并非在带标签的检测数据集上校准；评分器尚未针对手机识别结果进行验证。
