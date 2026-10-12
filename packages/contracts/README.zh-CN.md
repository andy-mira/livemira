# Contracts 0.1.0

[English](README.md) | [简体中文](README.zh-CN.md)

LiveMira 各模块的共享类型与验证器。导入 `@livemira/contracts`。从代码仓库根目录运行 `npm ci && npm test`。此软件包为私有（不发布到 npm）；`private` 是一种发布保护措施，而非许可限制。TypeScript 5.9.3 是唯一的构建依赖；npm lock 文件记录了其完整性。Node 25.9.0 和 npm 11.12.1 是经过测量的工具链；声明的 engine 范围并非经过测试的兼容性声称。

## 规范

- 矩阵为行优先，在左侧乘以列向量。单应性将原始目标像素映射到标准未镜像的跟踪像素。`normalizeHomography` 在安全时使用 h22，否则使用最大绝对元素标尺；奇异或非有限矩阵予以拒绝。
- 光栅特征中心为整数坐标 0..width-1。物理/渲染角点是按目标顺序排列的**边缘** (0,0)、(width,0)、(width,height)、(0,height)。请勿在屏幕空间中对角点重新排序。在 width-1 处采样角点的测试夹具在形成 `TrackingResult` 时必须进行转换。
- 所有时间单位均为微秒。`observationTimeUs` 是会话单调递增的**映射观测时间**，绝非原始媒体时间。不可用的曝光或时钟不确定性为 null。对于较旧的生成者，`mappedObservationTimeUs` 是可选的；到达时间仅是一项接收测量值。在仅凭源时间戳无法识别重复内容时，`imageIdentity` 用于标识重复内容。
- 源每次交付向 SDK 转移一个句柄。SDK 将其借用给管线和渲染消费者，等待所有工作（包括 GPU 完成），然后调用一次 release。所有者 release 必须是幂等的。SDK 队列最多容纳一个正在处理的帧和一个替换候选帧。被取消的计算 Promise 仅在借用的内存安全后才会完成返回；转移的 `PreparedFrame` 必须由其消费者显式释放。
- `TargetBundle` 使用 JSON 数组、gray8 金字塔以及显式的描述符类型和长度。`imageHashDomain` 默认为 `encoded-image`；编译器 gray8 输入必须标记为 `canonical-gray8`。验证器强制执行结构边界检查，而非真实性验证；目标编译器在其实例化边界验证受支持的算法和编译器，并计算或验证内容哈希。未定义紧密打包的生产格式；描述符绝不会被暗中转换。
- 跟踪质量 `spatialCoverage` 是内点凸包除以原始目标面积；预测结果不是成功的观测。即使没有新帧，SDK 也会使覆盖层过期。未知校准或物理尺寸意味着 T 为 null 且 `poseMetricValid=false`。K 绑定到标准几何；必须声明畸变处理方式。
- `FrameSource` 承诺进行源初始化；启动期间的回调在准备就绪前会被释放。`start` 必须响应其 `AbortSignal`。`stop` 使回调静止；迟到的交付会被释放。`VisionPipeline` 处理结果同时绑定会话和帧。识别器返回候选结果；确认属于跟踪管线。
- `nowSessionUs` 公开源会话时钟以用于 `predictionExpiresAtUs` 比较；在没有运行会话时返回 null。SDK 还会从接收时钟截止时间中扣除处理和渲染延迟，并且从不使用预测结果来刷新截止时间。没有会话时钟的通用适配器仅获得接收时钟边界，而非经过验证的捕获年龄边界。
- `RenderSink.setTargets` 是可选的尺寸注册；`connectEvents` 附加类型化的媒体错误和阻塞事件，返回退订函数并保持会话隔离。SDK 在 dispose 期间拥有断开连接的所有权。未知适配器异常文本不是公开的诊断数据。
- SDK `onDiagnostics` 是可选加入的，仅携带数值和标识元数据。CPU 提交、结果可用性和渲染提交使用源会话时钟；GPU 完成和可见时间在未测量时保持为 null。候选和陈旧丢弃是显式的。回调不能保留相机句柄，因为该记录中没有公开任何相机句柄。事件时间戳使用相同的源时钟（如果源缺少 `nowSessionUs`，则使用相对于会话的 SDK 时钟）；在停止后，回退机制保留最新的源偏移量。

## TypeScript / C++ / WGSL 边界

任何浏览器对象、JS 数值时间戳或不透明的 GPU 资源均不会隐式跨越原生 ABI。边界使用标量 u32 ID、长度和偏移量、float32 点对 (x,y)、float32 行优先矩阵以及具有显式步长（stride）的字节描述符；时间戳保持为 JS float64 微秒并与作业元数据关联。WebAssembly 内存增长会使借用的视图失效，因此在调用后请复制或重新获取视图。WGSL 矩阵需要显式的转置或按行构造，因为原生矩阵布局有所不同。

`DeviceService` 仅公开丢失通知、代际和空闲完成，从不公开内部 GPU 缓冲区。渲染器使用独立的设备并复制公开的 CPU 结果。在设备丢失时：取消作业、等待安全完成、使代际失效、隐藏、重新创建后端、重置跟踪并恢复捕获。未经适配器验证，SDK 绝不能将回退算法宣称为描述符兼容。

`ComputeBackend` 详情：`u8-exact` 精度；`CpuImagePayload` 携带相对于视图的 `byteOffset` 和 `byteLength`、步长、编码、预乘以及输入或标准空间。一旦具体后端提供 `PreparedFrame` 的 generation、level、scale、storage 和 preprocessing 字段，这些字段即变为必填项。每个 `buildPyramid` 条目都是单独拥有的幂等租约（包括基础层级），绝非无所有权的别名。`trackPoints` 可包含单点残差和原因。每个后端同时只有一个进行中的操作。当没有可用的 WebAssembly 模块时，标量 JavaScript CPU 是集成路径；WebAssembly 就绪情况单独报告。

对这些约定的新增内容均为可选择加入；不兼容的变更需要协调一致的迁移。
