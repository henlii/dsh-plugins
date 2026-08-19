# dsh-daily-sticky

每日语音便签 · DeepSeek Harness (dsh) **bundle 插件**

一个轻量浮动便签，从既有 `daily-voice-plan`（语音 + 番茄钟）演化而来——保留语音闭环、去掉番茄钟，换成勾选完成的便签 + JSON 按日日志 + 周/月环比统计。

![dsh-plugin](https://badgen.net/badge/dsh/plugin/green)

> 本目录是集合收录（bundle 形态，`src/*.js` 为构建产物）。源码仓库：
> **https://github.com/DoggyHU/dsh-daily-sticky**

## 功能

- **轻量浮动便签**：浮在 DSH 界面右上，可拖拽、可收起、可关闭。
- **勾选 = 完成（可取消）**：勾选划掉但保留在便签上；再点取消。
- **任务行**：可双击编辑文本、点备注编辑、可删除、可新增；支持多行粘贴批量添加。
- **未完成顺延**：昨天的任务自动滚到今天，下面用灰色小字标 `昨天` / `前天` / `3天前`（超过 3 天一折算），完成的不顺延。
- **AI 智能输入（双模式）**：手动输入，或贴一段杂乱口语/语音转文字 → 由 **DSH 当前正用的模型**（`agentDefaultModel`，同对话框通道）抽成便签任务，逐条勾选/改字后落盘；可自选模型（默认「跟随当前」）。
- **查漏**：扫描近两天所有会话，找出需要你处理的三种情况——**你问没答**（你在等 AI）、**模型在等你**（AI 在等你的决定）、**刚完成**（最近 AI 干完你还没回，默认折叠）。补录或忽略后打上 Tag，下次不再出现。
- **对话即写**：在对话里说「把这个加进便签 / 记一下 XXX」→ AI 直接写入当日 plan JSON（`sticky_*` 工具），便签轮询实时出现。
- **统计**：本周/本月 录入数、完成数、完成率 + 周环比 / 月环比（纯本地 JSON 计算，不调 LLM）。
- **JSON 落盘**：`plan/YYYY-MM-DD.json`（当日便签快照）+ `logs/YYYY-MM-DD.json`（事件日志）+ `gaps.json`（查漏已处理标记），按日持久化，重启/关机不丢。

## 数据位置

默认数据目录：`~/.dsh/dsh-daily-sticky/`

```
~/.dsh/dsh-daily-sticky/
├── plan/YYYY-MM-DD.json    当日便签快照（tasks 数组）
├── logs/YYYY-MM-DD.json    当日事件日志（events 数组，统计用）
└── gaps.json               查漏已处理标记（session_id → added/ignored）
```

## 安装

bundle 插件，独立安装（不在根 `cordis.patch.yml` 里 insert；其 patch 层由 `dsh.bundle.patch` 自动应用）：

```sh
# 从本目录
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-daily-sticky
# 或从 git 源
dsh plugin --profile web add github:DoggyHU/dsh-daily-sticky
```

装好重启 `dsh web`，刷新页面后右上角即出现便签。

> 依赖的 `@deepseek-ai/*` / `cordis` 由 dsh 官方运行时经 profile pnpm 闭包注入，不要自行声明。

## 开发 / 构建

源码在 https://github.com/DoggyHU/dsh-daily-sticky （TypeScript + esbuild）。本目录的 `src/index.js`（host bundle）与 `src/client.js`（client bundle）为构建产物，由 `node build.mjs` 生成。

## License

[MIT](LICENSE)
