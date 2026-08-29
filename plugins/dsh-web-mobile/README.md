<h1 align="center">dsh-web-mobile</h1>

<p align="center">
  <strong>dsh web 手机视口适配</strong> — 官方三栏改成单栏会话页，顶栏开关左右侧栏；独立安装即可用，装了本集合其它插件时自动接上。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

官方 dsh web 是桌面三栏（会话 | 对话 | 详情）。窄屏上对话会被 56px 会话轨挤掉；若同时装着
[dsh-sidebar](../dsh-sidebar/) 还会再被右侧 44px 固定轨切一刀。本插件在 **手机视口**
把外壳收成：

- **会话页**占满屏宽（默认，无底栏）
- 顶栏左侧打开官方会话列表，右侧打开工作区（文件 / Git / 信息 / 终端）
- 输入框下的官方统计行隐藏（用量在工作区「信息」）
- 设置等弹层改全屏，避免超出视口；输入框 16px，避免 iOS 聚焦放大

桌面视口（见下方判定）**不改**官方布局。本插件 **不 import** 其它插件：兄弟插件用 DOM
特征探测，没装就只保留「会话 / 对话」。

## 安装

**独立安装：**

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-mobile
```

**或全部安装（集合）：**

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 增加（或确认已在集合 patch 中）：

```yaml
- insert:
    - id: web-mobile
      name: 'dsh-web-mobile'
```

刷新页面。用手机或把窗口缩到 640px 以下即可看到顶栏左右侧栏按钮。

> 建议与 **dsh-web-auth** 一起部署：本插件没有自己的 `/api` 路由，但登录浮层会被一并收成窄屏卡片。

## 手机判定

| 视口 | 行为 |
|------|------|
| 宽度 &lt; 640px | 始终走手机壳 |
| 宽度 ≥ 1024px | 始终走官方桌面三栏 |
| 640–1023px 且粗指针、无 hover | 手机壳（覆盖手机横屏） |
| 640–1023px 且鼠标 | 官方窄屏（56px 轨），本插件不介入 |

## 能力

| 能力 | 说明 |
|------|------|
| 单栏会话 | 强制三栏轨道为 `0 / 1fr / 0`，隐藏列宽拖动手柄 |
| 顶栏按钮 | 左：会话列表抽屉；右：工作区全屏叠层（再点一次收回） |
| 会话抽屉 | 点工作区/分组只展开；点会话或「新建会话」才收回 |
| 工作区叠层 | 探测到 `dsh-sidebar` 时显示右侧按钮；含文件 / Git / 信息 / 终端 |
| 隐藏统计行 | 输入框下官方 StatsLine 不显示，用量看工作区「信息」 |
| 登录卡 | 探测到 `#dsh-web-auth-overlay` 时限宽、16px 输入、≥44px 按钮 |
| 安全区 / 键盘 | `viewport-fit=cover` + `visualViewport` 把输入框顶到键盘上方 |
| 窄屏停绘 | 未打开的会话列/工作区列 `display:none` + `inert`；首屏 critical CSS `content-visibility:hidden` |
| 主线程合并 | DOM / 键盘 / resize 经 `requestAnimationFrame` 每帧最多同步一次 |
| 流式降载 | 参考 dsh-perf：会话列表仅投影变化合并到 ~1Hz；屏外消息行 `content-visibility:auto` |
| 设置页卡片 | 「插件配置」tab 展开式卡片（order 40），只读说明当前探测到的兄弟插件 |

## 与其它插件的关系

| 插件 | 关系 |
|------|------|
| （无） | 只适配官方会话列表 + 对话 |
| dsh-web-auth | CSS 收登录卡；认证逻辑仍完全由 auth 负责 |
| dsh-sidebar | 顶栏出现右侧按钮；44px 右轨改成叠层内顶栏 |
| dsh-web-terminal | 终端在工作区顶栏里打开（侧栏已内嵌终端 tab） |

插件之间没有 npm / cordis 依赖，卸掉 sidebar 只是少右侧按钮。

## 插件管理

已装插件推荐用 [plugin-registry](https://github.com/vlln/plugin-registry) 的**薄控制台**
管理安装态，无需手改配置：

```sh
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```

## License

[MIT](../../LICENSE) © 2026 Henry Li
