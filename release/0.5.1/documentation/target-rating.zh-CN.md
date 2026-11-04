# @livemira/target-rating —— 目标图评分

[English](target-rating.md) | [简体中文](target-rating.zh-CN.md)

给扫描用的照片打分（0.5–5 星），在用户选目标图时（上传的图片，或视频的首帧、尾帧、任意一帧）提示他换一张更好的。

评分是独立模块，**不需要引擎**：作品编辑页这类页面不打开相机，只加载这一个文件即可。它在自己的 Worker 里按引擎 `compileTargetImage` 的方式解码、缩放、编译图片，再用引擎自己的检测器在合成画面上实测，所以分数针对的正是引擎将要跟踪的那份目标。

## 文件

| 文件                                         | 用途                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `files/livemira-target-rating.min.mjs`       | 单个 ES 模块，Worker 已内嵌（约 47 KB）。                              |
| `files/livemira-target-rating.mjs`           | 同一模块的可读版本。                                                   |
| `files/livemira-target-rating-worker.min.js` | 评分的 Worker 脚本（经典脚本），供 CSP 禁止 `blob:` Worker 的页面使用。 |
| `files/livemira-target-rating.d.ts`          | 类型声明。                                                             |
| `npm/livemira-target-rating-*.tgz`           | 离线包 `@livemira/target-rating`（不在 npm 上，可 `npm install` 这个文件）。 |

导入模块不会创建任何东西；第一次评分时才启动 Worker，空闲 4 秒后关闭。同一时间只评一张，其余排队。

## 用法

```js
import { rateTargetImage, RatingError } from './livemira-target-rating.min.mjs';

const controller = new AbortController();
try {
  const rating = await rateTargetImage(photoFile, { signal: controller.signal });
  showStars(rating.stars); // 0.5…5，半星
  if (rating.stars < 3) suggestAnotherFrame(rating.advice);
} catch (error) {
  if (error instanceof RatingError && error.code === 'UNSUITABLE_TARGET') showCannotUse(); // 引擎不会接受这张图
  else if (error?.code !== 'ABORTED') throw error;
}
```

- `rateTargetImage(image, { signal?, workerUrl?, maxEdgePx = 640 })`：图片文件（JPEG、PNG、WebP…，按图片自身的方向）。`maxEdgePx` 要与引擎 `compileTargetImage` 用的一致。
- `rateTarget(target, { signal?, workerUrl? })`：已编译的目标——引擎 `compileTargetImage`、`parseTarget` 得到的 bundle，或其 `bytes`。
- 换图时用 `signal` 取消上一次评分，过时的结果不会回来。
- 桌面每张约 0.5 秒，手机约 1–2 秒。

### 错误

`RatingError` 有 `code` 与 `message`：

| `code`              | 含义                                                       |
| ------------------- | ---------------------------------------------------------- |
| `UNSUITABLE_TARGET` | 引擎不会接受这张图：太小，或细节太少（识别点不足 48 个）。 |
| `DECODE_FAILED`     | 图片无法解码，或文件为空。                                 |
| `INVALID_TARGET`    | 目标数据损坏（`rateTarget`）。                             |
| `INVALID_INPUT`     | 不是图片文件或目标，或选项超出范围。                       |
| `WORKER_FAILED`     | Worker 无法启动（多见于 CSP 禁止 `blob:`）或运行出错。     |
| `ABORTED`           | 通过 `signal` 取消。                                       |

## 结果

```ts
{ stars, score, factors: { detail, spread, distinctiveness, recognition }, metrics, advice, points, width, height }
```

| 星级    | 含义                                                   |
| ------- | ------------------------------------------------------ |
| 5       | 各方面都接近最好：小、斜、晃、暗、被挡时也多能认出     |
| 4–4.5   | 好，适合作为目标图                                     |
| 3–3.5   | 可用：正对、距离适中时稳定，偏小、斜拍或晃动时容易丢失 |
| 2–2.5   | 勉强，建议换图或换帧                                   |
| 0.5–1.5 | 不建议                                                 |

建议：低于 3 星时提示换一张；3–3.5 星可以接受，但提示"扫描时正对、靠近"。

四项各 0..1：

| 项目                     | 含义                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `detail` 细节            | 编译器 14 个模拟视角中，至少 5 个都能检出的"稳定点"的数量（40 个以下为 0，250 个以上为满分）                                                                                                                                                                       |
| `spread` 分布            | 稳定点在画面网格（约 16 格，随长宽比）里铺开的程度：有足够点的格子占比、各格均匀度，再乘上最弱一角的系数（只要有一角几乎没有点，最多扣 40%）                                                                                                                       |
| `distinctiveness` 独特性 | 稳定点中，在远处找不到相似描述子的比例；同一角点在旁边几个像素处的近亲不算                                                                                                                                                                                         |
| `recognition` 实测识别   | 用引擎自己的检测器认 640 × 360 的合成画面，五项测试各由易到难：缩小（长边 160/120/90/70 px）、斜拍（45°/60°/70°）、晃动模糊（6/10/16 px）、暗光（对比降到 35%/20% 并加噪）、部分遮挡（遮住任一角或任一半）；每个画面换两种握持各试一次，按内点数计余量（刚好认出只算一部分）。各项结果见 `metrics.tests` |

分数 = 100 × (0.15 细节 + 0.4 分布 + 0.05 独特性 + 0.4 实测识别)；星级 = 0.5 + 4.5 × (分数从 15 到 95 线性对应)，并封顶于 1 + 4 × min(分布, 实测识别)^0.4，按半星取整。所以细节再多，只要挤在一处，或在合成画面里几乎认不出，也给不了高分。

`advice` 按重要性列出原因：

| 代码                                                                                | 含义                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `HARD_TO_FIND`                                                                      | 合成画面中多数认不出或很勉强                                     |
| `CONCENTRATED`                                                                      | 细节集中在画面的一部分                                           |
| `WEAK_QUARTER`                                                                      | 某一角几乎没有细节（`metrics.weakestQuarter`）                   |
| `FEW_DETAILS`                                                                       | 能从不同角度稳定认出的细节点偏少                                 |
| `REPETITIVE`                                                                        | 相似图案多（格子、砖墙、条纹等），容易认错位置                   |
| `FAILS_SMALL`、`FAILS_TILTED`、`FAILS_BLURRED`、`FAILS_DIM`、`FAILS_COVERED`        | 缩小、斜拍、晃动模糊、暗光、部分遮挡这一项明显差于一般照片       |

中文提示文字可参考示例 `demo/rate.js` 里的 `ADVICE`。`points` 是计入细节的点（目标像素坐标，`width` × `height`），可画在图上说明分布；`metrics.grid` 是各格的点数。

## 校准

权重与阈值按 28 张公开测试图（0.4.1 示例图所在的整套图，CC0）和 LiveMorae 演示照片校准：以仿真场景中引擎在较难条件下的检测率与手持跟踪的实测为准，评分与实测的等级相关约 0.6。星级的松紧经两轮真机体验调整，取在偏松与偏严两版的中间：这 28 张平均 4 星，其中 5 星 2 张、4.5 星 12 张、4 星 7 张、3.5 星 3–4 张、3 星及以下 3–4 张；0.4.1 的四张示例为鸟屋 4.5、森林 4.5、山脉 3–3.5、船 2.5，LiveMorae 演示照片 4。浏览器与 Node 的图片解码略有差别，个别图可能差半星。

示例里的 `rate.html` 是一个完整的评分页面：上传图片或视频（选首帧、尾帧、任意帧），显示星级、四项与五项识别明细、原因，以及稳定点与网格密度叠加图。

## 内容安全策略（CSP）

评分模块用 `blob:` 地址启动 Worker：请允许 `worker-src blob:`。不允许时，部署 `livemira-target-rating-worker.min.js` 并传 `workerUrl`。评分不需要 WebAssembly，也不发出任何网络请求。

## 浏览器要求

Worker、`createImageBitmap`；Worker 中的 `OffscreenCanvas` 2D 可用时在 Worker 内解码，否则在页面上解码后把灰度像素交给 Worker。

## 版本

评分模块与引擎分开构建（各自的构建 ID，见 `release-manifest.json` 的 `modules`）：评分的改动不会改变引擎文件。`RATING_VERSION`、`ratingBuildInfo` 给出版本与构建 ID。

## 许可

Apache-2.0。见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。
