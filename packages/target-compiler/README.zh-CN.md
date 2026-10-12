# CPU 目标编译器

[English](README.md) | [简体中文](README.zh-CN.md)

将紧密打包的 gray8 图像编译为 `TargetBundle`（特征、描述符和 gray8 金字塔），使用校验和封套将其序列化，并在完全验证的情况下反向解析。该适配器导入 `@livemira/contracts` 0.1.0。入口：`src/index.ts`；软件包入口 `index.mjs` 使用根构建。不存在外部运行时依赖，也没有复制的参考源码。

```ts
import { compileGrayTarget, serializeTarget, parseTarget } from '@livemira/target-compiler';
const target = await compileGrayTarget({width, height, data: packedGray8}, {
  targetId: 'poster-1', physicalWidthMeters: null,
});
const saved = await serializeTarget(target);
const loaded = await parseTarget(saved);
```

输入必须已经是正向、未镜像、紧密打包的 gray8。图像解码、EXIF 方向、颜色转换和相机几何属于调用方的职责；此编译器不实现这些转换。哈希是规范 gray8 字节的 SHA-256，显式标明 `imageHashDomain: canonical-gray8`；缺失的物理宽度保持为 null。在异步哈希之前对输入像素和尺寸建立快照。

## 算法

- **传统（默认），`m0-harris-brief256-v1`**：构建 box2 金字塔（四舍五入的 2x2 平均），在 box3 平滑后提取带有固定确定种子的 256 位正向 BRIEF 风格描述符的 Harris 角点，并诊断数量过少、凸包覆盖率低和重复描述符。该描述符**不兼容 ORB 或 MindAR**，且不具有旋转不变性。特征保留原始图像像素中心坐标；金字塔坐标映射为 `(p+0.5)*scale-0.5`。用于渲染的原始目标边缘保持为 `(0,0),(width,0),(width,height),(0,height)`。默认使用编译器 `webar-gray8-cpu/0.1.0`、384 个特征和三个 box2 层级。
- **ANMS，`m0-harris-anms-brief256-v1`**：相同的检测器、描述符和匹配器，在逐层选择中采用自适应非极大值抑制。
- **Oriented，`c-oriented-brief256-v2`（可选加入）**：`compileGrayTarget(gray, {targetId, algorithmVersion: 'c-oriented-brief256-v2'})` 默认生成编译器 `webar-gray8-cpu/0.2.0`、512 个特征和六个 1.2x 层级，预处理为 `bilinear-1.2-center` / `binomial3` / `intensity-centroid-r12`。最多接受八个层级；当任一维度低于 40 时实际深度停止。特征携带原始像素中心坐标，且几何与渲染边缘保持不变。

两条解析器路径均强制执行其精确的编译器、算法和预处理元组；更改字符串并不能迁移目标包。请保留原始像素并重新编译。共享的 `TargetBundle` 模式保持为 1，描述符长度保持为 32 字节。

边界：每维度 32..4096，最多 4,194,304 像素，传统算法为 1..4 个金字塔层级，16..512 个请求特征（默认 384）。空间配额可能导致实际特征较少。公开描述符存储是步长为 32 的扁平字节值数字数组；金字塔保存 gray8 像素数组。逐特征层级和得分保持为内部状态，因为公开的 `FeatureSet` 不包含它们。

## 序列化

封套为 JSON `{payload: string, sha256: string}`；校验和覆盖精确的 UTF-8 有效载荷字节。有效载荷是 contracts `TargetBundle` 模式 1。解析器在 JSON 解析前将 UTF-8 总字节数限制在 24,000,000 之内，验证校验和，运行共享结构验证，检查算法、编译器、域和边界、金字塔一致性、描述符字节范围以及规范 gray8 哈希。校验和用于检测损坏；它不是真实性证明。内存中的目标输入对于描述符出处是受信任的：匹配无法证明对抗性发布者实际编译了那些描述符。JSON 解析和数组存储耗费内存与时间；这不是紧凑的生产格式。诊断信息由识别过程重新计算，因此伪造的诊断信息无法覆盖质量拒绝。

`experimental/bundle.mjs` 是一种隔离的仅限 Node 的格式（`webar-m0-experiment/1`，无金字塔像素）。公开适配器有意拒绝它，且绝不能将其加载到 SDK 中。其独立的原始灰度 CLI 为：

```sh
node packages/target-compiler/experimental/cli.mjs input.gray 320 240 poster-1 output.json
```

该 CLI 拒绝覆盖已存在的输出文件。原始文件必须恰好为 width*height 字节。不宣称任何原始编码图像哈希。

## 构建

在 `npm ci` 之后，从代码仓库根目录运行：

```sh
node node_modules/typescript/bin/tsc -p packages/target-compiler/tsconfig.json
```

## 出处

原创实现。公开项目（MindAR，MIT；OpenCV，Apache-2.0）仅作为阅读材料参考；其代码均未被复制或链接。合成测试夹具为生成的矩形和棋盘格，不需要外部图像许可证。
