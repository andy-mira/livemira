# 计算后端

[English](README.md) | [简体中文](README.zh-CN.md)

在 CPU 上以标量或 SIMD WebAssembly 形式进行原生风格的预处理（灰度转换和高斯金字塔），外加一个可选的、Worker 安全的常驻 WebGPU 汉明匹配器（带有精确的 CPU 回退）。这两种方式都不意味着整个引擎运行在 WebAssembly 或 GPU 上：识别和跟踪均在 CPU 上运行。默认使用 CPU；GPU 匹配是显式开启的实验选项。收益取决于设备、浏览器和目标负载，启用前须验证完整相机链路的表现。

## 运行时入口点

`src/index.ts` 导出以下内容。这些模块是 Worker 安全的，没有 DOM 或 window 依赖。

```ts
const preprocessing = await createWasmPreprocessor({ variant: 'scalar', signal });
const copied = preprocessing.copyFrame(frame, signal);
// Native gray/pyramid operators with owned JS output, no exposed heap pointers.
const backend = new CpuComputeBackend(operators, preprocessing);
await backend.init();
await backend.dispose(); // also disposes its preprocessing instance

const matcher = new HammingMatcher();
await matcher.init(); // an unavailable GPU or a shader failure exposes an explicit CPU fallback
const exactMatching = createExactMatchingAdapter(matcher);
const recognizer = new CpuRecognizer({ exactMatching }); // oriented-v2 path only
// await recognizer.loadTargets(...), recognizeGray(...)
recognizer.dispose();
await matcher.dispose();
```

`CpuComputeBackend` 接收注入的 `CpuOperators`（特征检测、描述与匹配、点跟踪）；该后端拥有有界的资源生命周期（最多保留 32 个句柄和 32 MiB），且 `dispose` 会排空正在进行的活跃工作。每个准备好的帧或金字塔句柄都必须予以释放；`readGray` 返回拥有所有权的副本。`src/canonical-frame.ts` (`copyCanonicalFrame`) 在保留帧和会话标识以及尊重借用输入所有权的同时复制紧密打包的规范 gray8 或 RGBA8；它拒绝非规范方向、已释放句柄以及已中止的调用。

SDK 应用可通过 `createWorkerPipeline({ prepareFrame, options: { backendPreference: 'webgpu' } })` 为传统/ANMS 或 oriented-v2 目标请求精确 GPU 匹配。默认保持 `backendPreference: 'cpu'`。通过 `onCapability` 的 `operators.matching` 确认实际后端；识别与跟踪仍在 CPU 上，因此整体 `backend` 仍为 `cpu`。GPU 不可用时，传统匹配继续使用原 CPU 匹配器。处理中匹配设备代际变化会拒绝该帧并要求 reset，不会产生有效的过期姿态。上面的低层 `exactMatching` 示例仍仅适用于 oriented-v2。

### 汉明匹配

对于直接匹配，先执行 `setTargets([{id, descriptors: Uint8Array}])`，然后 `matchBatch(targetIds, frameDescriptors, signal)` 返回后端、版本、匹配项、耗时和 `fallbackReason`。最多保留十个目标快照；每个目标或帧最多包含 512 个 32 字节的描述符；一个批次最多包含十个候选目标。目标描述符在调用之间保留在 GPU 上，每个批次仅上传一次帧。仅返回前向最佳/次佳和反向最近归约，而不返回完整距离矩阵或图像。返回的配对包含 `targetIndex`、`frameIndex` 和 `distance`，按目标索引排序。

精确数值约定 `hamming32-mutual-ratio075-max64/1`：最佳 <= 64，严格满足 `4*best < 3*second`；仅接受唯一反向最近目标（反向距离相等时拒绝）。空输入不返回匹配项。所有距离和索引决策必须与 CPU 完全一致。匹配器不计算方向、描述符、检索或单应性。

`diagnostics` 和 `onCapabilityChanged` 公开实际后端、代际和回退原因。`invalidateGpu()` 会销毁当前 GPU 代际：等待已提交的工作，销毁临时缓冲区，未中止的匹配回退到精确 CPU。中止操作将导致拒绝，而不是在 CPU 上静默完成。处置会阻止新工作，等待初始化和活跃工作，并使缓冲区失效。允许一个进行中的批次，忙碌时 `setTargets` 会予以拒绝。CPU 循环在操作边界观察取消信号；硬取消通过终止 Worker 实现。

### WebAssembly 精确匹配（实验性）

`src/wasm-exact-matcher.mjs` 是传统 BRIEF 家族 JavaScript `matchPacked` 的纯 CPU 替代实现，自 0.2.1 起在 Worker 中默认选用（`WorkerPipelineOptions.cpuMatching` 省略或为 `'wasm-experimental'`；`'js'` 表示关闭；参见 SDK README）。`selectWasmExactMatcher()` 先尝试 SIMD 模块，再尝试标量模块：每个模块都必须通过 `WebAssembly.validate`、完成实例化，并在内置确定性自检（并列、边界、512 x 512）中复现 `matchHamming32` 的结果；否则 `matcher` 为 `null` 并附带原因，调用方继续使用 JavaScript。`WasmExactMatcher` 的数值契约和请求上限与 `HammingMatcher` 相同（十个常驻目标，每个至多 512 个描述符，每批次一帧至多 512 个，配对按目标索引升序）。它是同步的，在目标之间检查 `signal`，`dispose()` 释放实例及其内存。`createWasmExactMatchingAdapter(matcher, {onFailure})` 是识别器的 `legacyExactMatching` 算子：匹配器不可用或请求超出固定容量时解析为 `null`（该帧使用 JavaScript）；WebAssembly 失败时永久禁用匹配器、调用一次 `onFailure` 并同样解析为 `null`；中止则拒绝。

这些模块是原创的手写 WebAssembly 文本，位于 [`exact-matching-wasm/`](exact-matching-wasm)（Apache-2.0）：`hamming-exact-scalar.wat`（MVP `i64.popcnt`）和 `hamming-exact-simd.wat`（固定宽度 SIMD128 `i8x16.popcnt`，每步处理四个帧描述符；不使用 relaxed SIMD，不使用线程）。二者均使用一个不可增长、布局固定的 4 页内存，无导入、无分配器，不含第三方代码，因此无需额外声明。[`exact-matching-wasm/build.mjs`](exact-matching-wasm/build.mjs) 使用 [`exact-matching-wasm/toolchain-pin.json`](exact-matching-wasm/toolchain-pin.json) 中固定的 WAT 汇编器 `wabt`（npm 完整性校验、tarball 与 `index.js` 哈希；仅构建时使用，不是依赖项，也不重新分发）将其汇编为生成文件 `src/exact-matching-wasm-binaries.mjs`（base64，因此单文件 Blob Worker 从不请求 `.wasm`）和 [`exact-matching-wasm/manifest.json`](exact-matching-wasm/manifest.json)（源码、工具链与输出哈希）。该脚本从不下载；请在仓库之外获取一次固定版本的包：

```sh
npm pack wabt@1.0.39 && tar -xzf wabt-1.0.39.tgz -C <dir>
node packages/compute/exact-matching-wasm/build.mjs --wabt <dir>/package --check   # byte-identical rebuild, or omit --check to regenerate
```

开发仓库的测试套件（不属于公开源码）将清单与源码及内嵌字节进行核对（当 `LM_WABT_DIR` 指向固定版本的包时还会运行重建检查），并将两个变体与定义级预言（oracle）、`matchPacked`、冻结的 RC5 预言以及 `matchHamming32` 进行比较。公开源码包含 WAT 源文件、`build.mjs`、`manifest.json` 和工具链固定信息，便于审阅并重建内嵌二进制。

### WebAssembly 限制

WASM 在固定 64 MiB 堆上每次转换支持 <= 1,048,576 像素和 <= 8 MiB 的源有效负载，在 `finally` 中释放临时分配，返回副本，并在处置时丢弃模块引用。保留的模块或堆引用会阻止垃圾回收；JavaScript 无法强制解除堆映射。`copyFrame` 使用原生 RGBA 转换；已是灰度的输入在 JavaScript 中复制。金字塔下采样是与原生和 JavaScript 参考实现完全一致的整数高斯采样。它既不是 oriented-v2 金字塔，也不是 tracking 软件包的归一化 Lucas-Kanade 金字塔，切勿静默替代其中任何一个。

## 数值约定

算法 ID `e-preprocess-u8-v1`。RGB 采用编码字节 RGB；忽略 alpha，不做解预乘（unpremultiplied）。亮度 Luma = `(77R+150G+29B+128)>>8`，为整数近似，非线性光转换。金字塔使用 `[1,4,6,4,1]` 的外积、边缘截断（edge clamping）、在双轴处理后进行单次 `(sum+128)>>8` 舍入、向上取整（ceil）尺寸，以及以 `(2x,2y)` 为中心的采样。某一层的像素按 `2^level` 映射回原图，没有半像素偏移。金字塔在 1x1 处停止。灰度和金字塔在 CPU/WASM/GPU 上的验收容差恰好为 0 字节差异。

`native/common/preprocess.*` 是等效的标量 C++ C ABI，具有源和目标字节容量；需要单独且不重叠的调用方自有缓冲区，并且运算符不进行分配、不抛出异常、不拥有帧，也不异步运行。`src/reference.mjs` 是具有所有权输出的 JavaScript 参考实现（RGBA8 输入可能有行填充；无效、空或超尺寸布局在分配前即失败；最多 16,777,216 像素）。`shaders/gray.wgsl` 是实验性整数灰度运算符（每像素一个打包的 RGBA u32 输入，一个灰度 u32 输出；它需要四倍于 CPU gray8 的存储空间，未启用生产使用）。`src/probe.mjs` 是可丢弃的 WebGPU 设备探测工具。

## 预构建 WebAssembly 产物

根构建**不编译原生代码**。它复制并嵌入固定锁定在 `artifacts/{scalar,simd}/compute.{mjs,wasm}` 中的预构建模块，其大小和 SHA-256 记录在 [`prebuilt-artifacts.json`](prebuilt-artifacts.json) 中。单文件引擎嵌入标量模块。SIMD 必须在选择前进行运行时探测，标量是默认项，不存在 pthread 构建。`createWasmPreprocessor` 未实现显式 SIMD 模块失败后的自动标量回退；调用方捕获初始化失败并报告 CPU 回退。

许可：C++ 源代码与项目的其余部分一样遵循 Apache-2.0。生成的 `compute.mjs` 胶水代码和 `compute.wasm` 还包含遵循其自身许可证的上游代码，不进行重新许可：Emscripten (`EMSCRIPTEN-LICENSE.txt`)、musl libc (`MUSL-COPYRIGHT.txt`)、LLVM libc++ (`LIBCXX-LICENSE.txt`：带有 **LLVM Exceptions** 的 Apache License v2.0 以及保留的历史许可证，而非单纯的 Apache License 2.0）和 dlmalloc (`DLMALLOC-NOTICE.txt`：Emscripten 默认 malloc/free 的公有领域贡献）。另请参阅根目录 `NOTICE`。编译器工具链在 `toolchain-pin.json` 中标明，但不进行重新分发。

### 重新构建路径

这些模块是使用 [`toolchain-pin.json`](toolchain-pin.json) 中锁定的 Emscripten 4.0.15 构建的（emsdk commit、emcc commit 以及官方 `emscripten/emsdk:4.0.15` 容器镜像的摘要）。[`scripts/build-wasm.ps1`](../../scripts/build-wasm.ps1) 是记录的构建入口点。它是为 Windows PowerShell 环境编写的；**未**在其他平台上进行验证，且不宣称支持跨平台重新构建。它从不下载 SDK。在 `PATH` 中包含锁定的 `emcc`，或通过 `-UseDocker` 按摘要使用官方镜像：

```powershell
powershell -NoProfile -File scripts/build-wasm.ps1 -Variant scalar
powershell -NoProfile -File scripts/build-wasm.ps1 -Variant simd
```

该脚本使用 `-std=c++17 -O2 --no-entry` 将 `native/common/preprocess.cpp` 编译为适用于 web、worker 和 node 的模块化 ES6 模块，带有固定的 64 MiB 堆 (`-sALLOW_MEMORY_GROWTH=0`)，并导出 `_e_rgba_gray`、`_e_pyr_down`、`_malloc` 和 `_free`；SIMD 变体增加了 `-msimd128`。重新构建会产生新的产物字节：在用于构建发布版本之前，将其哈希记录在 `prebuilt-artifacts.json` 中。固定堆无法容纳任意最大尺寸的 RGBA 帧加上输出，因此适配器必须处理分配失败；预期的工作负载是 640x360。线程已禁用。

## 原生参考构建

```sh
cmake -S native -B build/native
cmake --build build/native
ctest --test-dir build/native --output-on-failure
```

在 MSVC 上添加 `-A x64` 和 `--config Release`。`tests/compute/native-reference.cpp` 是预处理 ABI 的原生等价性检查。

## 类型检查

```sh
node node_modules/typescript/bin/tsc -p packages/compute/tsconfig.json
```

## 出处

原创实现。仅作为阅读材料参考的项目（WebARKitLib 为 LGPL-3.0，BabylonAR 为 MIT）既未被复制也未被链接，在将来采纳此类代码之前需要进行传递性许可证审查。
