# LiveMira 0.4.1

[English](README.md) | [简体中文](README.zh-CN.md)

浏览器图像目标 AR：在设备本地完成识别、跟踪、视频叠加，并提供可选相机界面。

| 目录 | 内容 |
| --- | --- |
| `files/` | 可读与压缩 ES 模块、独立 Worker、TypeScript 类型声明。 |
| `npm/` | 五个 npm 离线安装包。 |
| `demo/` | 静态 Demo 与带授权说明的示例资源。 |
| `documentation/` | 引擎、UI、扩展及迁移指南。 |

将 `files/` 中的模块复制到应用中，或从 `npm/` 安装离线包：

```sh
npm install ./npm/livemira-engine-0.4.1.tgz ./npm/livemira-ui-0.4.1.tgz
```

参见[引擎指南](documentation/engine.zh-CN.md)、[相机 UI 指南](documentation/ui.zh-CN.md)、
[版本变化](CHANGELOG.md)与[源码](../../README.zh-CN.md)。
通过 HTTPS 或 localhost 提供 `demo/`；相机需要安全上下文与用户授权。

相机界面的真机兼容性尚未确定，Android 与应用内浏览器尚未验证。
请在应用支持的设备上验证相机、播放与转屏行为。快速移动可能丢失跟踪；
转屏时视频叠加可能额外显示约一帧。

`release-manifest.json` 记录模块构建标识与文件哈希；`SHA256SUMS` 覆盖除自身之外的发布文件，
包括 manifest。在本目录运行 `shasum -a 256 -c SHA256SUMS` 可验证完整性。

Apache-2.0，见 [LICENSE](LICENSE)、[NOTICE](NOTICE)与[示例资源授权](demo/assets/CREDITS.md)。
