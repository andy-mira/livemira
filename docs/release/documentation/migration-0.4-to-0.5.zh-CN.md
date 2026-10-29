# 从 0.4.1 升级到 0.5.0（LiveMorae 集成步骤）

本文面向把 0.5 集成进 LiveMorae 前端（`LiveMorae/infra/local/web`）的人。结论先说：

- **相机界面 `@livemira/ui` 的接口不变**：`mountScanCamera.ts`、`ScanController.ts`、`scanConfig.ts`、`scanTargets.ts`、`scanMessages.ts` 不需要改代码。
- **发布目录结构不变**：`scripts/sync-livemira.mjs` 可以直接安装引擎与相机界面；要用目标图评分，同步脚本多装一个文件（第一节）。
- 需要改的只有版本号两处，以及在真机上做验收。
- **已集成 rc.1 或 rc.2 的**：重新运行第一节的同步脚本，再把第二节各处的版本号换成 `0.5.0` 即可；相机界面接口没有变化。引擎的 `rateTarget` 已移到独立的评分模块（第四之一节）。新增的可选项：`engineOptions.camera.processingScale`（默认 1 即相机原尺寸，不必设置）。

## 一、安装

```bash
npm run livemira:sync -- /绝对路径/livemira-0.5.0
```

脚本会校验 `SHA256SUMS`，把 `files/livemira-engine.min.mjs`、`LICENSE`、`NOTICE` 装到 `public/assets/livemira/0.5.0/`，把 `npm/livemira-ui-0.5.0.tgz` 解到 `vendor/livemira-ui/`，并删除 0.4.1 的引擎目录。要用目标图评分，把 `files/livemira-target-rating.min.mjs` 加进脚本的 `ENGINE_FILES`（同目录、同一份校验清单），它就和引擎装在一起。之后：

```bash
npm install --offline --ignore-scripts --no-audit --no-fund && npm run build && npm test
```

## 二、要改的版本号

1. `src/features/scan/scanEngine.ts`：`ENGINE_VERSION = '0.5.0'`。
2. `tests/liveMiraRelease.test.ts`：把期望的 `'0.4.1'` 改为 `'0.5.0'`，共 6 处：版本号、两处资源目录、`ENGINE_VERSION` 的正则（`0\.4\.1`）、篡改检查里的引擎路径和旧版本复制源。
3. `tests/scanTargets.test.ts`：`ENGINE_VERSION` 的断言改为 `'0.5.0'`。
4. 文档里写着当前版本的地方：`src/features/scan/README.md`，以及项目的 `README.md`、`Docs/PROJECT_STATUS.md` 的集成记录。

## 二之一、测试里的假引擎改为 0.5 接口

`tests/support/fakeEngine.ts` 模拟的是 0.4.1 的引擎接口，不改的话 `tests/scanHost.test.ts` 会有 7 项失败。产品代码不受影响。要改的内容：

- `setTargets` 收到的是目标包数组，每项直接带 `targetId`，不再是 `{ target }`；
- 补上 `setTargetProgress`；
- `compileTargetImage` 返回完整的目标包（`format`、`widthPx`、`heightPx`、`pointCount`、`bytes`）；
- 事件改为 `media`（原 `mediaState`）、`ended`（原 `sessionEnded`），事件不再带 `sessionId`、时间戳等字段；
- 静音改为引擎级的 `media.isMuted`（`setTargetMedia` 不再带 `isMuted`）；
- 删去 0.4 才有的 `camera`、`getEventContext`、`getDiagnostics`。

`tests/scanHost.test.ts` 里要相应改：

- `targetFound` 事件只带 `targetId`；
- 播放状态用 `media` 事件；
- "视频静音开始"改为检查引擎的静音状态；
- 0.5 的相机与照片编译同时进行，调用顺序变为 `['start', 'setTargets:a,b']`。

改完后 112 项测试全部通过（2026-10-23 在本地集成中验证）。

本版引擎模块照旧导出 `ENGINE_VERSION`、`engineBuildInfo`（`buildId` 与发布清单一致，`variant` 为 `'minified'`）、`createEngine`、`compileTargetImage`，这个测试的其余断言不受影响。

## 三、行为变化（用户能感觉到的）

| 方面       | 变化                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| 识别与跟踪 | 新一代引擎（默认档位 Swift）。真机测试中跟随更稳、大斜角更好，不支持 WebGL2 的设备不再识别并会提示。         |
| 准备阶段   | 照片编译与打开相机同时进行，相机授权提示更早出现；中间显示带百分比的加载卡片。                               |
| 视频加载   | 识别后立即出现与视频同比例的半透明黑色区域，中间转圈；视频能播放时从区域中心向四周展开。见下文第四节（边下边播）。 |
| 扫描引导   | 未识别时屏幕中央显示扫描框。                                                                                 |
| 振动       | 识别到照片时轻振一下（Android 支持时）。如不需要，在 `mountScanCamera` 的选项里加 `isHapticEnabled: false`。 |
| 取景       | `SCAN_OPTIONS` 的 `engineOptions: { camera: { fit: 'contain' } }` 仍然有效，画面与以前一样完整显示。         |
| 丢失宽限   | 仍为 200 ms，期间视频淡出。                                                                                  |

0.4 引擎的其他选项（`processingLongEdge`、`capture`、`timestamps`、`tracking.maxPredictionMs`、`adapters`、`extensions`、`diagnostics`）在本版中不存在，LiveMorae 目前也没有使用。

## 四、视频边下边播（需要 LiveMorae 决定）

本版默认把视频 URL 直接交给浏览器播放，下到够播就开始，不再等整个文件下载完。但**宿主传了自己的 `loadMedia` 时，默认仍是整段下载**（保持兼容）：LiveMorae 的私有视频靠 `fetchMediaBlob` 加 `Authorization: Bearer` 头，而浏览器的 `<video>` 无法附加请求头，直接播放会被 401 拒绝。

- **公开示例（`/demo/scan`，`createPublicMediaLoader` 的固定公开文件）**：可以直接开启，在这个入口的会话选项里加 `video: { isLooping: true, fit: 'contain', isStreamed: true }`。请求会带本站 Cookie（原加载函数是 `credentials: 'omit'`），对公开文件没有影响；跨域的视频需要 CORS。
- **私有作品集**：要边下边播，服务器需要提供浏览器能直接播放的地址，例如短时有效的签名 URL，或按 Cookie 鉴权的媒体地址，再开启 `isStreamed`。在那之前保持默认（整段下载），新的加载区域与展开动效照样生效，只是要下完才播放。
- 开启后，视频取不到（例如链接过期）时，`classifyError` 在 `video-load` 阶段收到的 `cause` 是带 `code` 的 `Error`（`'network'` 或 `'unsupported'`，浏览器对 403/404 一般报后者），**没有 HTTP 状态码**。`ScanController.ts` 里按 `ApiError` 404 判断"视频已过期"的逻辑只在整段下载时有效。

整段下载时，`loadMedia` 的第二个参数多了一个可选的 `onProgress(0..1)`：`fetchMediaBlob` / `loadDemoMedia` 在下载时调用它，照片上的进度环与状态行就显示百分比；不调用时显示转圈。

## 四之一、可选：选目标图时评分

评分是独立模块 `livemira-target-rating.min.mjs`，不需要引擎（[说明](target-rating.zh-CN.md)）。LiveMorae 作品编辑页在用户选定首帧、尾帧、自定义帧或指定图片后调用即可，像 `scanEngine.ts` 那样按版本号动态导入：

```ts
const { rateTargetImage } = await import(/* @vite-ignore */ `/assets/livemira/${ENGINE_VERSION}/livemira-target-rating.min.mjs`);
const rating = await rateTargetImage(photoFile, { signal });
```

公开测试图平均 4 星（5 星只给各方面都接近最好的图）。建议低于 3 星时提示用户换一张；3–3.5 星可以接受，但提示“扫描时正对、靠近”。引擎不会接受的图（太小或细节太少）会以 `RatingError` `UNSUITABLE_TARGET` 拒绝。原因见 `rating.advice`，文字可参考示例 `demo/rate.js` 里的 `ADVICE`。换图时用 `signal` 取消上一次评分。

## 五、可选：预先编译照片

照片多、设备弱时，浏览器内编译需要数秒（每张约 0.2 秒桌面、估计 0.5 秒 iPhone、2–3 秒低端 Android）。目标可以在上传照片时编译一次并保存，扫描时把字节作为 `target` 传入（`{ id, target: bytes, video }`），跳过编译。本版的编译函数在浏览器中运行；如果要在服务器上编译，请提出，我们再提供 Node 版本。

## 六、部署检查

- CSP 与 0.4.1 相同：需要 `worker-src blob:` 与 `script-src 'wasm-unsafe-eval'`（评分模块只需要前者）。
- 资源路径变为 `/assets/livemira/0.5.0/livemira-engine.min.mjs`；如果有按版本号写的缓存或 CDN 规则，一并更新。
- Docker 构建仍需在 `npm ci` 之前 `COPY vendor/livemira-ui`。
- 边下边播的视频：媒体服务器（或 CDN）要支持 Range 请求，iPhone 的 Safari 只认分段响应；nginx 与常见 CDN 默认支持。

## 七、验收（需要真机）

1. iPhone（Safari、微信）与 Android（Chrome、微信）各开一次 `/demo/scan` 和一个私有作品集相机。
2. 依次确认：
   - 加载卡片的进度从 0 到 100；
   - 相机授权提示出现；
   - 扫描框出现；
   - 对准照片后，立即出现与视频同比例的半透明黑色区域，中间转圈；
   - 视频能播放时从区域中心展开（开启边下边播的入口不用等视频下载完）；
   - 移开照片后提示"照片移开了"，对回后继续播放；
   - 开关声音；
   - 转屏时出现"正在调整画面…"；
   - 切到后台再回来，提示"页面进入后台"并可"重新开始"。
3. 链接过期（404）与未登录（401）的提示仍是 LiveMorae 自己的文字。
