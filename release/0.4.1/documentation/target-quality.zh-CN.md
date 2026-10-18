# @livemira/target-quality

[English](target-quality.md) | [简体中文](target-quality.zh-CN.md)

在编译之前，为图片作为目标的适合程度打分（0 至 5）。它对图片运行引擎自己的特征提取，因此衡量的正是编译器会编译的内容。单独构建为一个模块（`livemira-target-quality.min.mjs`），不需要引擎。

```js
import { assessTargetImage } from './livemira-target-quality.min.mjs';

const result = await assessTargetImage(file);
if (result.shouldReplace) alert(result.advice);
```

**评分公式 2.0.0。** 稳定位姿的五个条件，各为 0..1 的线性斜坡，锚点取自引擎常量：特征**支撑**（24 → 192 个特征）、凸包**覆盖**（15% → 60%）、特征在图片上的**离散度**、**条件数**（各方向分布是否均匀）与**唯一性**（近重复描述子少）。得分 = 5 ×（0.5 × 平均 + 0.5 × 最小），因此单一条件不合格无法被其他条件掩盖；编译器会拒绝的图片最高 2 分。低于 3 分建议更换图片。

得分是启发式预检，不是经过校准的识别概率：3 分以上的图片在设备上仍可能失败。对比度会报告但不计分。

| 接口                                                     |                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `assessTargetImage(blob, options?)`                      | 在本地解码文件并打分。选项：`signal`、`maxImageBytes`、`maxPixels`、`environment`。 |
| `assessGrayTarget(gray)`                                 | 为灰度图 `{ widthPx, heightPx, data }` 打分，同步执行。                             |
| `analyzeTargetImage` / `analyzeGrayTarget`               | 同上，另返回得分所依据的模板特征点。                                                |
| `drawTemplateFeatures(context, features, box, options?)` | 以空心圆绘制模板特征（静态，绝非实时匹配）。                                        |
| `scoreMetrics(input)`                                    | 纯评分步骤。                                                                        |

图片先缩小到长边 640 像素再打分，与编译器相同。不上传任何内容；解码资源在成功、出错与取消时都会释放。

Apache-2.0。
