# Native 识别状态

[English](README.md) | [简体中文](README.zh-CN.md)

不存在原生识别二进制文件。可执行的数值基线是 `packages/recognition/experimental/{features,geometry}.mjs` 中的原始 JavaScript 实现，通过 contracts 适配器进行调用。原生或 WebAssembly 移植尚未实现；CPU 计算后端可以在不复制代码的情况下委托给这些导出项。

移植要求：保留描述符种子和模式、字节序、box2 舍入、box3 平滑以及像素中心缩放；匹配特征平局仲裁（tie-break 规则）与互为最近邻/比率规则（reciprocal/ratio rules）；对照确定性测试比对归一化单应性重投影和退化行为。原生 float32 与 JavaScript float64 的容差需要经过实测的一致性。一个成功的不相关的原生预处理构建（`native/common`）并不能验证识别几何或描述符的等价性。
