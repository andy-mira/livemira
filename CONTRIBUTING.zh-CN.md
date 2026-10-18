# 参与 LiveMira 开发

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

感谢参与。本文说明仓库的组织方式，以及一个改动合并前需要满足的条件。

## 准备

Node.js ≥ 25.9（见 `.node-version`）；npm workspaces。

```sh
npm ci
npm run check   # 与 CI 相同：格式、lint、类型、API 报告、版本、结构、内容、WebAssembly、测试
```

浏览器探针需要 Playwright 的 Chromium 与 WebKit：

```sh
npm run test:browser
```

设置 `LIVEMIRA_BROWSERS=chromium` 只跑 Chromium；已安装的 WebKit 版本不匹配时，用 `LIVEMIRA_WEBKIT_PATH` 指定。桌面
浏览器不能复现所有手机行为（尤其是 iOS 原生视频层）；涉及相机、视口门控、渲染或媒体的改动还需要在手机上确认。

## 结构与依赖

- `packages/*` 是引擎各模块。依赖单向：`contracts` ← 算法与采集各包 ← `sdk`（`@livemira/engine`）← `apps`。
  `npm run check` 会拒绝反向、循环依赖和深引用（引用其他包的 `src/` 内部文件）。
- 可选扩展（`tracking-visuals`、`recognition-diagnostics`、`target-quality`）不会成为引擎的依赖；它们只使用引擎的类型。
- `apps/demo` 只使用引擎、扩展与页面外壳的公开入口。Demo 需要内部能力时，说明公开 API 有缺口，应补 API。
- 每个包只通过 `src/index.ts` 导出。

## 代码

- TypeScript 严格模式、ES 模块，只用可擦除语法（不用 `enum`、参数属性、`namespace`）：测试用 `node --test` 直接运行
  源码。相对导入以 `.ts` 结尾。
- 格式由 Prettier 决定（`npm run format`）；ESLint 必须通过。
- 命名：布尔值用 `is`/`has`/`should`/`can` 开头；物理量带单位（`timestampUs`、`quietMs`、`widthPx`）；矩阵命名为
  `H_targetFromSource`。
- 注释用英文，解释"为什么"而不是"做了什么"。公开 API 需要 TSDoc：用途、单位、错误、生命周期。
- 每个源文件开头：

  ```ts
  /*! Copyright 2026 Andy (@andy-mira)
   * SPDX-License-Identifier: Apache-2.0
   */
  ```

- 不引入新的运行时依赖：引擎不打包任何第三方代码。

## 行为与算法

- 识别、跟踪、匹配与几何目前逐位确定：相同输入得到相同字节。改变其输出就是行为变化，须在合并请求中说明并给出测量
  结果，同时写入 `CHANGELOG.md`。
- 已知缺陷在代码中以 `// KNOWN-ISSUE:` 标记，每次改动只修一条，并各自写 CHANGELOG。
- 不为了让测试通过而放宽断言。

## 公开 API

`api/*.api.md` 记录每个发布模块的公开 API。改动导出时运行 `npm run build:types` 并提交更新后的报告，评审者看它的
差异。报告过期时 `npm run check` 失败。

## 版本

只有根 `package.json` 的版本号需要手改。改完运行 `npm run version:sync`；任何包、锁文件或 `ENGINE_VERSION` 不一致时
检查失败。

## 提交与合并请求

- 遵循 [Conventional Commits](https://www.conventionalcommits.org/)，摘要用英文祈使句，例如
  `fix(media): keep the plane hidden after a decode error`。
- 一个提交只做一件事，小到可以单独评审和回退。
- 测试与文档随改动一起提交。使用者能感知的变化写入 `CHANGELOG.md`。
- 测试输出写到被忽略的目录（`reports/`、`test-results/`、`logs/`），不写回受跟踪的文件。
- 受跟踪的文件中不出现本机路径、工具署名、凭据或开发过程记录；`npm run check` 会检查。

## 许可

提交贡献即表示同意按 [Apache License 2.0](LICENSE) 第 5 条授权你的贡献。
