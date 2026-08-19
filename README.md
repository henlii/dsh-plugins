<h1 align="center">dsh-plugins</h1>

<p align="center">
  <strong>DeepSeek Harness (dsh) 自定义插件集合</strong> — 每个插件可独立安装，也可通过集合 patch 一次性全部安装。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

`dsh-plugins` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
**插件集合仓库**。集合内每个插件都是独立的 npm 包（纯 cordis 插件形态，0811 官方规范），
挂在 dsh web profile 上：

- **独立安装**：只想用一个插件时，按该插件 README 安装单个包 + insert 行；
- **全部安装**：应用本仓库根 `cordis.patch.yml`（一次性插入所有插件行），`dsh web --patch` 即挂载全部。

## 插件目录

| 插件 | 功能 | 安装 |
|------|------|------|
| [dsh-web-auth](plugins/dsh-web-auth/) | 内网/LAN/Tailscale 访问密码认证 + 信任：非回环 `/api` 与 WebSocket 需密码登录，认证后设置/凭据等特权页在内网可用 | 独立 / 全部 |
| [dsh-sidebar](plugins/dsh-sidebar/) | 右侧边栏：当前会话工作区文件树 + Git 状态/diff（pidance 式常驻菜单条），点击文件展开二级编辑 | 独立 / 全部 |
| [dsh-daily-sticky](plugins/dsh-daily-sticky/) *(dsh plugin)* | 每日语音便签：浮动便签（勾选/编辑/删除/批量）+ AI 智能输入（DSH 当前模型抽取）+ 查漏（你问没答 / 模型在等你 / 刚完成，补录或忽略打 Tag 去重）+ 未完成顺延（昨天/前天/3天前）+ 周/月环统计 | 独立（bundle 插件） |

## 安装

### 全部安装（一次性）

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

或把 [cordis.patch.yml](cordis.patch.yml) 的内容并入你的 profile 的
`$DSH_HOME/profiles/web/cordis.patch.yml`（配置 HMR 实时生效，无需重启）。

### 独立安装（单个插件）

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/<name>
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加对应 insert 行（见各插件 README），
配置 HMR 实时生效。详细步骤见 [docs/INSTALL.md](docs/INSTALL.md)。

> 注意：插件依赖的 `@deepseek-ai/*` / `cordis` 由 dsh 官方运行时经 profile pnpm 闭包注入，
> **不要**在插件 `package.json` 里声明这些依赖（官方未发布到公共 npm，声明反而解析失败）。

## 仓库结构

```text
dsh-plugins/
├── cordis.patch.yml         # 一次性全部安装的 patch 层（insert 所有插件）
├── docs/
│   ├── INSTALL.md           # 安装指南（独立 / 全部 / 配置）
│   └── CONTRIBUTING.md      # 新增插件规范
├── examples/                # 各插件独立安装示例
└── plugins/
    └── <name>/              # 每个插件 = 独立 npm 包
        ├── package.json     # main/exports + dsh.client 声明
        ├── src/index.js     # Node half（Cordis entry）
        ├── src/client.js    # Client half（__ModuleLoader__.load）
        └── README.md        # 该插件文档
```

## 开发 / 新增插件

新增插件遵循官方 0811 插件规范（纯 cordis 或 bundle 形态），详见
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) 与官方
[make-dsh-plugin](https://github.com/vlln/plugin-registry/blob/main/skills/make-dsh-plugin/SKILL.md) 引导。

## 插件管理

已装插件推荐用 [plugin-registry](https://github.com/vlln/plugin-registry) 的**薄控制台**
（浏览器面板）管理安装态（bundle 层栈 + insert 行 + 启停），无需手改配置：

```sh
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```

## License

[MIT](LICENSE) © 2026 Henry Li
