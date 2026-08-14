<h1 align="center">dsh-sidebar</h1>

<p align="center">
  <strong>dsh web 右侧边栏：当前会话工作区文件树 + Git 状态/diff，点击文件展开二级编辑</strong><br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

在 dsh web 右侧栏（`details` 插槽）渲染 pidance/OpenChamber 式工作区面板：
**常驻图标菜单条**（文件 / Git / 信息，Git 带变更数角标）+ 内容面板。参照
[pidance 的 RightPanel](https://github.com/henlii/pidance/blob/main/components/RightPanel.tsx)：

![dsh-sidebar 预览](docs/preview.png)

- **文件**：当前会话工作区文件树（目录折叠、自动跳过 node_modules/.git 等），
  文件带 Git 状态徽标（M/A/D/??）；
- **Git**：分支 + 变更列表，点击文件 → diff 视图（未跟踪文件显示内容预览）；
- **信息**：工作区名、路径、会话 id、Git 状态；
- **二级编辑**：点击文件展开编辑视图（textarea + 保存），或 diff 视图，返回按钮回列表。

> 注意：注册 `details` 插槽会**替换**官方右侧栏的工具详情面板（方案 A，single 插槽语义）。

## 安装

**独立安装：**

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-sidebar
```

**或全部安装（集合）：**

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 增加（或确认已在集合 patch 中）：

```yaml
- insert:
    - id: sidebar
      name: 'dsh-sidebar'
```

安装后刷新页面，打开右侧栏（布局开关）即可看到面板。

> 建议与 **dsh-web-auth** 一起部署：该插件的 `/api/dsh-sidebar/*` 路由会被
> dsh-web-auth 的密码认证自动保护（非回环访问需登录）。无认证层部署时这些路由
> 在局域网内是开放的（文件读/写），注意访问边界。

## 能力

| 能力 | 说明 |
|------|------|
| 工作区文件树 | 当前会话 `header.cwd` 的文件树，目录折叠，跳过重型目录 |
| Git 状态 | `git status --porcelain` 解析：分支、变更列表（index/worktree 字母） |
| 文件 diff | `git diff -- <path>`；未跟踪文件显示内容预览 |
| 二级编辑 | 点击文件展开编辑器（读取 → textarea → 保存 → 刷新树） |
| 常驻菜单条 | 右缘 44px 图标轨道，Git 变更数角标，面板收起仍显示 |

## 安全边界

- 数据走 `/api/dsh-sidebar/*` 精确路由（dsh-ssh 同款模式）；
- 推荐与 dsh-web-auth 同装，由其密码认证门禁保护（回环免密）；
- 无认证部署时路由开放，仅建议在受信内网使用。

## 插件管理

已装插件推荐用 [plugin-registry](https://github.com/vlln/plugin-registry) 的**薄控制台**
管理安装态，无需手改配置：

```sh
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```

## License

[MIT](../../LICENSE) © 2026 Henry Li
