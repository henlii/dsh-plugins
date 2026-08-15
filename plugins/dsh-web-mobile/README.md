<h1 align="center">dsh-web-mobile</h1>

<p align="center">
  <strong>dsh web 手机视口适配</strong> — 官方三栏改成单栏对话 + 底栏叠层；独立安装即可用，装了本集合其它插件时自动接上。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

官方 dsh web 是桌面三栏（会话 | 对话 | 详情）。窄屏上对话会被 56px 会话轨挤掉；若同时装着
[dsh-sidebar](../dsh-sidebar/) 还会再被右侧 44px 固定轨切一刀。本插件在 **手机视口**
把外壳收成：

- **对话**占满屏宽（默认）
- 底栏切换 **会话**（官方左侧栏抽屉）、**工作区**（`dsh-sidebar` / 官方 details 全屏叠层）、**终端**（`dsh-web-terminal` 全屏叠层）
- 为底栏、刘海/Home 条、软键盘留白；输入框 16px，避免 iOS 聚焦放大

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

刷新页面。用手机或把窗口缩到 640px 以下即可看到底栏。

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
| 单栏对话 | 强制三栏轨道为 `0 / 1fr / 0`，隐藏列宽拖动手柄 |
| 会话抽屉 | 底栏「会话」展开官方左侧栏；点遮罩或再点一次收回 |
| 工作区叠层 | 探测到 `dsh-sidebar` 时出现「工作区」；侧栏自动 `openDetails` 在手机上被按回 |
| 终端叠层 | 探测到 `.wterm` 时出现「终端」；未打开时不占对话高度；分隔条支持触摸拖动 |
| 登录卡 | 探测到 `#dsh-web-auth-overlay` 时限宽、16px 输入、≥44px 按钮 |
| 安全区 / 键盘 | `viewport-fit=cover` + `visualViewport` 把输入框顶到键盘上方 |
| 设置页卡片 | 「插件配置」tab 展开式卡片（order 40），只读说明当前探测到的兄弟插件 |

## 与其它插件的关系

| 插件 | 关系 |
|------|------|
| （无） | 只适配官方会话列表 + 对话 |
| dsh-web-auth | CSS 收登录卡；认证逻辑仍完全由 auth 负责 |
| dsh-sidebar | 底栏多一项「工作区」；44px 右轨改成叠层顶栏 |
| dsh-web-terminal | 底栏多一项「终端」；给分隔条补 pointer 拖动 |

插件之间没有 npm / cordis 依赖，卸掉任何一个兄弟插件只是少一个底栏项。

## 插件管理

已装插件推荐用 [plugin-registry](https://github.com/vlln/plugin-registry) 的**薄控制台**
管理安装态，无需手改配置：

```sh
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```

## License

[MIT](../../LICENSE) © 2026 Henry Li
