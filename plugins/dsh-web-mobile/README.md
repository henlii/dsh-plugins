<h1 align="center">dsh-web-mobile</h1>

<p align="center">
  <strong>dsh web 手机端界面</strong> — 侧栏变覆盖层抽屉（不再永久占用屏幕宽度），设置变两级页面，桌面布局原样不动。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

dsh web 是桌面三栏（会话 | 对话 | 详情）。窄屏上外壳会把左栏收成一条 52px 图标轨，但这根轨
在 390px 的手机上永久吃掉 14% 宽度；把侧栏拉开时它又会**挤压**对话列，而不是盖在上面。设置弹层
同理：导航与内容左右并排，内容被压到一字一行。

本插件只在手机视口接管这些布局：

| | 桌面 | 手机（本插件） |
|---|---|---|
| 左栏收起时 | 52px 图标轨 | 完全不占位，对话占满屏宽 |
| 左栏展开时 | 挤走对话（280px + 110px） | 覆盖层抽屉 + 遮罩，对话宽度不变；点遮罩或选中会话即收起 |
| 右栏 | 轨道 | 打开时全屏覆盖 |
| 设置 | 导航 + 内容左右并排 | 两级页：一级是导航列表，点进去是二级页（带返回），一级有 ✕ |
| 输入框 | 跟随主题 | 16px（iOS 聚焦不再放大页面） |
| 安全区 | — | `viewport-fit=cover` + `env(safe-area-inset-*)` + `100dvh` |

判定：视口 ≤ 640px 一律算手机；640–1024px 之间仅当指针是 `(hover: none) and (pointer: coarse)`
（触摸设备）才算。**桌面视口不做任何改动**，插件的样式表与注入节点都不落地。

## 安装

包自带 `dsh.bundle.patch`，官方 CLI 一条命令装完即挂载：

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-mobile

# 或从 npm
dsh plugin --profile web add @henlii/dsh-web-mobile
```

CLI 会把它加进 profile 的 `dsh.profile.bundles`，无需手改配置。手动挂法见本仓库根的
`cordis.patch.yml`，两种方式**二选一**。

零配置：插件没有配置项。

## 实现要点

- **抽屉状态不自己持有**。外壳把当前状态写在 frame 元素上：收起时
  `data-sidebar-collapsed="true"`，展开时**整个属性被摘掉**（不是写 `false`）。插件把它镜像成
  `html[data-dshm-left|data-dshm-right]`，所以抽屉的开关始终等于外壳自己的状态；点遮罩收抽屉
  走的是 `ctx.layout.toggleSidebar()`（服务缺失时退回点官方按钮），不会出现「插件以为关了、外壳
  以为开着」的分叉。
- **不依赖 CSS Module 哈希**。宿主每次构建都会改 `pI_x6G_` 这类前缀，所以元素都用语义钩子找：
  frame 用 `[class$="frame"]`，列用 `[data-dsh-center-col]` / `[data-rightbar-col]` /
  `[class$="sidebarCol"]`，设置弹层用结构定位（`nav[class$="_nav"]` 的父节点 + 兄弟节点），再给
  它们打上插件自己的 `dshm-*` 类名。
- **首帧**：index.html 原本没有 `viewport-fit=cover`，手机首帧会先画出细轨再回流；Node half 通过
  `webServer.tapIndex` 往 `<head>` 注入 viewport meta 与一段手机宽度的 critical CSS。
- 无 `@deepseek-ai/*` 运行时依赖，不 import 任何插件。

## 已知限制

- 手势（左缘右滑开抽屉、抽屉左滑关闭）未做，只有按钮与遮罩交互。
- 横屏（高度 < 500px）没有单独布局，按普通手机宽度处理。
- 右栏覆盖层按外壳的 `data-rightbar-collapsed` 判定；如果某个第三方右侧栏不走这套状态，它不受
  本插件影响（也就不会变成覆盖层）。

## License

[MIT](../../LICENSE) © 2026 Henry Li
