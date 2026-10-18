# @livemira/recognition-diagnostics

[English](recognition-diagnostics.md) | [简体中文](recognition-diagnostics.zh-CN.md)

可选的引擎扩展：汇总有界的识别诊断数值——目标**为何**被拒绝（按阶段、原因码与识别轮次）、各识别阶段耗时，以及实测结果的匹配点落在目标**何处**（凸包覆盖、离散度、各向同性）。不保存画面、网址或点数组，快照可以放进诊断日志。单独构建为一个模块（`livemira-recognition-diagnostics.min.mjs`），引擎不会加载它。

```js
import { createRecognitionDiagnostics } from './livemira-recognition-diagnostics.min.mjs';

const recognition = createRecognitionDiagnostics();
const engine = createEngine({ container, diagnostics: log, extensions: [recognition] });
// 之后
log.setSection('recognition', recognition.snapshot());
```

扩展会让引擎提供识别轨迹与匹配点（创建引擎时确定），并从引擎读取目标尺寸。拒绝阶段描述的是识别器对单帧候选的检验，不等于跟踪器是否接受结果；点分布只统计实测的 TRACKING 结果。

| 接口                                                                          |                                                                                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `createRecognitionDiagnostics(options?)`                                      | `maxSessions` 1..16（4）、`maxTargets` 1..32（16）、`maxReasons` 1..64（24）、`minDispersionIntervalMs` 0..60000（200）、`nowMs`。 |
| `snapshot()`                                                                  | 格式 `livemira-recognition-diagnostics/2`：每个会话的识别计数、阶段耗时、逐轮统计、结果、点分布与各目标计数；丢弃计数。            |
| `reset(sessionId?)`                                                           | 忘记一个或全部会话；被忘记会话的迟到事件会被丢弃。                                                                                 |
| `observeRecognition(trace)` / `observeResult(result)` / `setTargets(targets)` | 供宿主自行传入数据。                                                                                                               |
| `dispose()`                                                                   | 释放全部资源。                                                                                                                     |

Apache-2.0。
