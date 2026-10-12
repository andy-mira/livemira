# 可选跟踪视觉效果

[English](README.md) | [简体中文](README.zh-CN.md)

这个独立加载的 RenderSink 装饰器用于绘制已识别的目标边界和当前匹配的内点。核心引擎从不导入它。绘制标志和核心点收集默认均关闭。

构建：`npm run build` 生成 `dist/tracking-visuals-single/lm-tracking-visuals.mjs` 和 `.min.mjs`、自包含声明以及闭包/哈希审计。任一配套运行时均无任何导入项、Worker、WASM 或记录器；将其复制到您自己的静态资源旁，仅在需要时导入。独立的目标质量工具保持互不相干。

```js
import {CssVideoRenderSink, createWorkerPipeline, createEngine} from './lm-engine.min.mjs';
import {TrackingVisualRenderSink} from './lm-tracking-visuals.min.mjs';
const base = new CssVideoRenderSink({geometryForResult});
const renderer = new TrackingVisualRenderSink({base, geometryForResult, boundary: true, points: true});
const pipeline = createWorkerPipeline({prepareFrame, options: {collectMatchedPoints: true}});
const engine = createEngine({source, pipeline, renderer});
```

`geometryForResult` 必须解析恰好针对该会话和帧捕获的标准图像到视口变换。黄色圆点来自所接受观测的实际内点；在预测、捕获和丢失期间它们不存在。在有效的短暂预测期间，绿色边界变为虚线琥珀色。丢失会立即清除辅助几何图形，即使视频在其配置的 500 ms 宽限期内保持可见也是如此。停止、置于后台、错误以及目标或会话替换也会将其清除。异步的旧更新不能重新填充新会话。

`renderer.setVisualization({boundary, points})` 在下一个有效帧更改绘制并立即清除旧几何图形；这两个标志都不会启动相机。点收集按 Worker 管线固定，因此切换收集需要重新创建管线。装饰器拥有基础渲染器处置的所有权并转发引擎事件。可以在 `base` 上调用媒体便捷方法；其媒体事件会使旧辅助几何失效。仅在手势重试成功后使用 `clearMediaFailure()`。

软件包导出项：`@livemira/engine/tracking-visuals`（压缩独立文件）、`/tracking-visuals/single`（可读版）以及 `/tracking-visuals/single/min`；仅用于 SDK 的多文件模块为 `@livemira/engine/development/tracking-visuals`。完整集成参见 `packages/sdk/README.md`（作为软件包 `docs` 目录中的 `INTEGRATION.md` 提供）。
