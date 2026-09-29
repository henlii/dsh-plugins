<h1 align="center">dsh-plugins</h1>

<p align="center">
  <strong>DeepSeek Harness (dsh) 插件集合</strong> — 插件以独立 npm 包发布，自带给 profile 的挂载层，官方 CLI 一条命令装好即用。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件集合。
每个插件都是独立的 npm 包（纯 cordis 插件形态，0811 官方规范），包内自带
`dsh.bundle.patch` 挂载层，装完自动挂上，无需手改 profile。

## 插件目录

| 插件 | 功能 |
|------|------|
| [dsh-web-auth](plugins/dsh-web-auth/) | 内网 / LAN / Tailscale 访问的密码认证 + 信任：非回环 `/api` 与 WebSocket 需密码登录，认证后设置、凭据等特权页在内网可用 |
| [dsh-web-mobile](plugins/dsh-web-mobile/) | 手机端 UI：去掉常驻细轨，左右侧栏改覆盖层抽屉，设置改成两级页（列表 → 详情），处理安全区与 16px 输入框；桌面布局不变 |
| [dsh-updater](plugins/dsh-updater/) | dsh 更新器：检查 npm dist-tags 与 GitHub release 两个来源、浏览并检索版本历史、升级到通道最新版或指定版本，升级与重启服务为两个独立按钮 |

## 安装

### 官方 CLI（推荐）

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/<name>

# 或从 npm
dsh plugin --profile web add <包名>
```

CLI 会把包加进 profile 的 `dsh.profile.bundles`，启动时自动合并包内的 patch 层，
插件随之出现在「插件」页的「已安装」里。部署自己的配置在
`$DSH_HOME/profiles/web/cordis.patch.yml` 里按行 id 覆盖，配置 HMR 实时生效（详见各插件 README）。

### 集合 patch（手动挂）

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

或把 [cordis.patch.yml](cordis.patch.yml) 的内容并入 profile 的
`$DSH_HOME/profiles/web/cordis.patch.yml`。

> 两种方式**二选一**：包已经进了 `dsh.profile.bundles`，再用集合 patch 的 `insert` 行挂一次，
> 就是同一个插件装两遍，插件树会因重复注册启动失败。

> 插件依赖的 `@deepseek-ai/*` / `cordis` 由 dsh 官方运行时经 profile 的 pnpm 闭包注入，
> **不要**在插件 `package.json` 里声明这些依赖（官方未发布到公共 npm，声明反而解析失败）。
> 例外是工具类包（如 `@deepseek-ai/dsh-atomic-write`）：它不作为服务注入，可以正常声明。

## 平台兼容

- **Linux / macOS / Windows**：路径经 `node:path` / `homedir` / XDG / `%APPDATA%` 解析，无 `/root` 等硬编码；
- **dsh-desktop**：插件作为普通 dsh 插件在桌面壳内照常工作。

## 仓库结构

```text
dsh-plugins/
├── cordis.patch.yml         # 手动挂法（insert 行）；与 CLI 安装二选一
├── docs/
│   ├── INSTALL.md           # 安装指南
│   └── CONTRIBUTING.md      # 新增插件规范
├── examples/                # 各插件独立安装示例
└── plugins/
    └── <name>/              # 每个插件 = 独立 npm 包
        ├── package.json     # main/exports + dsh.bundle / dsh.client 声明
        ├── cordis.patch.yml # bundle 挂载层（insert 自己那一行）
        ├── src/index.js     # Node half（cordis entry）
        ├── src/client.js    # Client half（__ModuleLoader__.load；纯客户端插件可省）
        └── README.md        # 该插件文档
```

## 开发 / 新增插件

新增插件遵循官方 0811 插件规范（纯 cordis 或 bundle 形态），详见
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) 与官方
[make-dsh-plugin](https://github.com/vlln/plugin-registry/blob/main/skills/make-dsh-plugin/SKILL.md) 引导。

## License

[MIT](LICENSE) © 2026 Henry Li
