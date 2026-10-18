# @livemira/tracking-visuals

[English](README.md) | [简体中文](README.zh-CN.md)

可选的引擎扩展：在相机画面上绘制识别出的目标边框与当前匹配内点。单独构建为一个模块（`livemira-tracking-visuals.min.mjs`），引擎不会加载它。

```js
import { createEngine } from './livemira-engine.min.mjs';
import { createTrackingVisuals } from './livemira-tracking-visuals.min.mjs';

const visuals = createTrackingVisuals({ boundary: true, points: true });
const engine = createEngine({ container, extensions: [visuals] });
visuals.setVisualization({ boundary: true, points: false }); // 随时可改
```

- **边框**：对每个呈现的 TRACKING 或 LIMITED 结果绘制——实测为绿色，短时预测为琥珀色虚线。
- **匹配点**：同一个实测结果的匹配内点；预测结果没有点。匹配点由 Worker 提供，只有以 `points: true` 创建扩展时引擎才会请求。
- 当引擎隐藏视频平面、丢失后保持、停止、开始新会话、页面隐藏，或正在显示的目标的媒体出错或被替换时，绘制被清除。
- `getDiagnostics()` 只返回计数，不含坐标。

这些只是引擎自身几何的绘制，不能证明识别正确。

| 接口                                      |                                                              |
| ----------------------------------------- | ------------------------------------------------------------ |
| `createTrackingVisuals(options?)`         | `{ boundary?: boolean, points?: boolean }`，默认都为 false。 |
| `setVisualization(options)`               | 修改开关。                                                   |
| `getVisualization()` / `getDiagnostics()` | 当前开关；显示的边框与点数。                                 |
| `currentMatchedPoints(result)`            | 结果的当前实测内点，或 null。                                |

Apache-2.0。
