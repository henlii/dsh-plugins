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
| 右栏 | 轨道 | 不动：外壳自己就在 <768px 把它做成全宽抽屉 |
| 设置 | 导航 + 内容左右并排 | 两级页：一级是导航列表，点进去是二级页（带返回），一级有 ✕ |
| 表格 | ≥4 列的容器写死 `overflow-x:hidden`（只有悬停才露滚动条） | 只把 `overflow-x` 改成 `auto`；宽度 / 位置 / 内边距一律不动 |
| 输入框 | 跟随主题 | 16px（iOS 聚焦不再放大页面） |
| 安全区 | — | `viewport-fit=cover` + `env(safe-area-inset-*)` |
| 滚动模型 | 文档滚动 + 输入框 `sticky` 贴底 | **不动**（锁 `html,body` 或给框架定高会破坏输入框的 sticky，见下） |

判定：**视口宽度 < 1024px**，与外壳自己的窄屏常量 `SIDEBAR_AUTO_COLLAPSE = 1024` 完全一致——
这是刻意的，否则会出现"外壳已收成细轨、插件还没接管"的中间态。宽视口（≥1024px）**不做任何改动**，
插件的样式表与注入节点都不落地。

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
- **只归零网格的第一轨**。外壳的 frame 是 `sidebar | center | rightbar` 三轨网格，写成两轨或一轨都会
  把右栏单元格挤到第二行（宿主把右面板 `position:absolute` 挂在自己的单元格上），面板就会跑到屏幕外；
  收起的侧栏也不能用 `display:none`（网格项消失会让后面的列左移一轨，把对话压进 0px 轨）。所以插件
  只把第一轨改成 `0px`，中/右两轨逐字沿用外壳写在内联样式里的值。
- **不依赖 CSS Module 哈希**。宿主每次构建都会改 `pI_x6G_` 这类前缀，所以元素都用语义钩子找：
  frame 用 `[class$="frame"]`，列用 `[data-dsh-center-col]` / `[data-rightbar-col]` /
  `[class$="sidebarCol"]`，设置弹层用结构定位（`nav[class$="_nav"]` 的父节点 + 兄弟节点），再给
  它们打上插件自己的 `dshm-*` 类名。
- **首帧**：index.html 原本没有 `viewport-fit=cover`，手机首帧会先画出细轨再回流；Node half 通过
  `webServer.tapIndex` 往 `<head>` 注入 viewport meta 与一段手机宽度的 critical CSS。
- 无 `@deepseek-ai/*` 运行时依赖，不 import 任何插件。

## 不改宿主的滚动模型

窄屏下外壳的会话是**文档自己滚**、输入框靠 `position:sticky` 贴在视口底部。插件一旦写
`html,body{overflow:hidden;height:100%}` 或给框架定死 `height:100svh`，sticky 的滚动参照就从文档
变成被锁死的框架，输入框会跟着消息一起滚出屏幕——**这个坑是本人踩的**：0.2.1 / 0.2.2 两版都在给
它打补丁，方向完全错了。现在插件不碰任何高度 / overflow，只做四件事：

- 网格第一轨归零（去细轨）+ 抽屉挂在栏的内层；
- 设置弹层的两级视图；
- 16px 输入框、安全区；
- 表格容器 `overflow-x:auto`（唯一一条不限宽度的规则；**只改 overflow**，见下）。

### 表格：只改 overflow，别碰宽度

宽表格的容器是宿主**特意放宽**的：比正文列宽（1600px 下容器 1249 vs 正文 845），并向左溢出 202px
让首列仍与正文对齐。写成 `max-width:100%` 会把它压回正文宽度 845，表格随后整体错位、最后一列被
推到视野外——这是本插件 0.2.3/0.2.4 犯过的错。现在只把宿主的 `overflow-x:hidden` 改成 `auto`：
几何与宿主逐像素一致，只是最后一列从"裁掉且滚不动"变成"能滚出来"。

## 已知限制

- 手势（左缘右滑开抽屉、抽屉左滑关闭）未做，只有按钮与遮罩交互。
- 横屏（高度 < 500px）没有单独布局，按普通手机宽度处理。
- 宽视口（≥1024px）不接管：那里外壳用轨道式右栏，属于桌面布局。

## License

[MIT](../../LICENSE) © 2026 Henry Li
