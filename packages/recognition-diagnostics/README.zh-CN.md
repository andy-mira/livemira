# 可选识别诊断配套模块

[English](README.md) | [简体中文](README.zh-CN.md)

这个可独立加载的配套模块用于跟踪在识别轮次中**目标为何被拒绝**，以及在跟踪过程中**匹配的内点位于何处**。它**不属于**引擎运行时的一部分：核心引擎闭包中没有任何代码导入它（引擎构建器对此进行门控），并且它也不从引擎导入任何内容。它作为自身独立的模块分发。

输出是**纯数值且有界的**（计数器、均值、最小值/最大值；绝不输出图像像素、URL、坐标或点数组），可以安全地随诊断日志一起导出。

## 可移植导出与分发

`@livemira/engine` 的软件包入口：
- 生产入口：`@livemira/engine/recognition-diagnostics`（下方的压缩独立文件）
- 仅用于 SDK 的多文件模块（开发用途，不在稳定生产接口之内）：`@livemira/engine/development/recognition-diagnostics`
- 独立 ES 模块（可读版）：`@livemira/engine/recognition-diagnostics/single` (`tools/recognition-diagnostics/lm-recognition-diagnostics.mjs`)
- 独立 ES 模块（压缩版）：`@livemira/engine/recognition-diagnostics/single/min` (`tools/recognition-diagnostics/lm-recognition-diagnostics.min.mjs`)

具名可移植导出项：
- `createRecognitionDiagnostics(options?: RecognitionDiagnosticsOptions): RecognitionDiagnostics`
- `DIAGNOSTICS_SCHEMA = 'webar-recognition-diagnostics/1'`
- `RecognitionDiagnosticsError`

## 引擎接缝与输入回调

该配套模块连接到引擎运行时中两个通用的、默认禁用的接缝：
1. `WorkerPipelineOptions.observeRecognition`（默认 `false`）+ `WorkerPipelineConfig.onRecognitionTrace` $\to$ 输入至 `collector.observeRecognition(trace)`
2. `WorkerPipelineOptions.collectMatchedPoints`（默认 `false`）+ `WorkerPipelineConfig.onResult` $\to$ 输入至 `collector.observeResult(result)`

当这两个选项均为 `false`（默认）时，引擎产生零诊断开销、零匹配点跟踪开销，且不提取任何额外特征。

```js
import { createWorkerPipeline, prepareWorkerFrame, getFrameGeometry } from '@livemira/engine/single/min';
import { createRecognitionDiagnostics } from '@livemira/engine/recognition-diagnostics/single/min';

const diagnostics = createRecognitionDiagnostics({
  maxSessions: 4,               // 1..16, default 4
  maxTargets: 16,               // 1..32, default 16
  maxReasons: 24,               // 1..64, default 24
  minDispersionIntervalMs: 200, // 0..60000, default 200 (~5/sec rate limit)
});

// Provide target dimensions (in target pixels) for normalization
diagnostics.setTargets([
  { targetId: 'poster-a', widthPx: 640, heightPx: 480 },
]);

const pipeline = createWorkerPipeline({
  prepareFrame: (frame, signal) => prepareWorkerFrame(frame, getFrameGeometry(frame), signal),
  options: {
    observeRecognition: true,
    collectMatchedPoints: true,
  },
  onRecognitionTrace: trace => diagnostics.observeRecognition(trace),
  onResult: result => diagnostics.observeResult(result),
});
```

## 阶段耗时与逐轮事实（可选跟踪字段）

来自较新引擎的追踪可能携带 `stageMs`（特征/检索/匹配/几何/总计毫秒数，按各轮次累加）和 `passes`（1..2 条记录：标准图像和半倍频程尺度重试；`passes.length` 必须等于 `legacyScalePasses`）。该配套模块独立于整数计数器对它们进行验证：持续时间必须是有限的、非负的且至多 600000 ms，`scale` 属于 (0, 1]；违规（NaN、Infinity、负数、过大、超过两个轮次、计数错误）会将整个追踪作为 `malformed` 丢弃。没有这些字段的追踪（较旧的引擎）仍可正常工作。

新的快照字段，均独立于原始字段（原始字段保持不变且从不重复计算）：
- `sessions[].stageTiming`：携带 `stageMs` 的追踪上的 `traces` 数量以及五个阶段耗时的连续运行统计数据（`n/mean/min/max`）。
- `sessions[].passStats.first` / `.second`：按轮次位置 `n` 计算的 `prepareMs`、阶段耗时、`featureCount`、`candidateCount` 的连续运行统计数据，以及 `ambiguous`、`budgetExhausted`、`accepted` 的计数。第二轮仅在尺度重试后存在；追踪的 `featureCount` 是最后一轮的计数，而非总和。
- `sessions[].targets[].passRejections.first` / `.second`：该轮次拒绝原因的 `total` 和 `byReason`，从而使第一轮的原因在成功的重试后得以留存。`rejections` 保持仅统计 `trace.rejected`（最后一轮）。

## 生命周期与有界计数器

- `setTargets(targets: readonly DiagnosticsTarget[])`：更新已知目标尺寸（最多 32 个目标）。将匹配点位置归一化回目标空间所必需。
- `observeRecognition(trace: TraceInput)`：记录每个目标的逐轮识别统计数据和失败原因。
- `observeResult(result: ResultInput)`：记录跟踪结果状态和内点分布统计。仅统计真正测量的、满足 `result.quality.measured === true` 且 `predictionAgeUs === 0` 的 `TRACKING` 结果；预测/保持/丢失帧绝不计入点分布。
- **速率限制**：点分布计算受 `minDispersionIntervalMs` 限制（默认 200 ms，无论帧率如何，每秒最多约 5 次计算）。
- `snapshot(): DiagnosticsSnapshot`：提取跨活跃会话的当前数值计数器。
- `reset(sessionId?: string)`：遗忘单个会话或所有活跃会话。遗忘会话的后续事件将被丢弃，而不是被重新计数。
- `dispose()`：清除所有会话和目标数据；后续调用变为空操作（no-op）。

## 拒绝阶段描述的是识别器（RECOGNIZER），而非最终跟踪器接受

由诊断模块分类的拒绝阶段：
- `target-diagnostics`：初始图像检查（`LOW_TEXTURE`、`LOW_COVERAGE`、`REPETITIVE_TEXTURE`）
- `retrieval`：候选检索过滤（`NOT_SHORTLISTED`、`RETRIEVAL_AMBIGUITY`）
- `matching`：特征对应匹配（`INSUFFICIENT_MATCHES`）
- `geometry`：单应性 / 位姿验证（`DEGENERATE_MODEL`、`DEGENERATE_REFINEMENT`、`NO_ROBUST_MODEL`、`LOW_INLIER_SUPPORT`、`LOW_SPATIAL_COVERAGE`）
- `boundary`：几何边界有效性（`INVALID_BOUNDARY`）
- `ambiguity`：多目标消除歧义（`AMBIGUOUS_TARGETS`）
- `other`：未分类的原因代码

> [!IMPORTANT]
> 拒绝阶段计数描述的是**识别器（RECOGNIZER）**内部的单帧候选拒绝。它们**并不**代表最终的跟踪器接受或拒绝。跟踪器拥有其自身的时间一致性、预测机制和状态机；被识别器接受的候选仍可能被跟踪器过滤或保持。

## 空间选择：ANMS 与传统算法对比

引擎支持两种传统家族的空间特征选择算法：
1. `m0-harris-brief256-v1`（传统基线）：基于贪婪响应的特征选择。
2. `m0-harris-anms-brief256-v1`（Brown, Szeliski, Winder CVPR 2005 §3 ANMS）：自适应非极大值抑制。

### ANMS 算法细节与刻意近似

在 CVPR 2005 §3 中，角点候选 $i$ 获得一个抑制半径：
$$r_i = \min_j |\mathbf{x}_i - \mathbf{x}_j| \quad \text{for } j \text{ where } \text{strength}_i < 0.9 \cdot \text{strength}_j$$
在特征预算（384 个模板 / 512 个实时特征，3 个金字塔层级）内选择具有最大抑制半径的候选。

引擎实现的近似处理：
- **有界候选池**：每个金字塔层级仅最强的 1,024 个候选（`ANMS_POOL_LIMIT = 1024`）参与抑制半径评估。这将工作量限制在至多 $1024^2 / 2 \approx 5.2 \times 10^5$ 次距离评估内，而不是数千个原始 Harris 角点上的 $O(N^2)$ 二次爆炸。由于强于池中成员的任何候选也都在池中，因此为池中成员计算的半径是精确的。
- **逐层配额**：应用于每个金字塔层级，而非全局跨所有层级应用。
- **确定性排序**：平局决胜严格为确定性：半径降序，然后强度降序，然后 $y$，然后 $x$。
- **独特的算法 ID**：使用 ANMS 编译的目标必须指定 `algorithmVersion: 'm0-harris-anms-brief256-v1'`，以确保包编译器/worker/匹配器的一致性。会话内混用算法版本将被拒绝。

### 已知局限性：更多的点并不总是更准确

ANMS 强制特征在图像上空间分散，这防止了特征在高对比度纹理中紧密聚集。然而，在一个固定的合成探测（比例为 0.85 的 360x640 帧）中，传统算法给出了 32 个内点，最大角点误差为 3.010 px，而 ANMS 给出了 43 个内点，最大角点误差为 5.402 px。此类误差是否通过取决于容差：满足参考目标对角线的 1%（在该测试夹具上约为 5.475 px），但不满足投影目标对角线的 1%（约为 3.272 px），也不满足更严格的固定 4.0 px 探测。

- **结论**：更多的匹配点和更广的空间分布并不能保证更低的角点重投影误差。一个假设性的解释（非经验证的因果关系）是，更高的内点数可能会引入远端边缘的点，其单应性杠杆作用增加了对噪声的敏感性。
- **不宣称手机性能提升**：合成回归结果并不暗示或证明在实体移动设备上识别或跟踪的改善。
