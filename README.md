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

- **独立安装**：只用这个插件时，官方 CLI 一条命令装完即挂载（包自带 `dsh.bundle.patch`）；
- **集合 patch**：不把包加进 `dsh.profile.bundles` 时的手动挂法，`dsh web --patch` 即挂载。

## 插件目录

| 插件 | 功能 | 安装 |
|------|------|------|
| [dsh-web-auth](plugins/dsh-web-auth/) | 内网/LAN/Tailscale 访问密码认证 + 信任：非回环 `/api` 与 WebSocket 需密码登录，认证后设置/凭据等特权页在内网可用 | 独立 / 全部 |

## 平台兼容

- **Linux / macOS / Windows**：路径经 `node:path` / `homedir` / XDG / `%APPDATA%` 解析，
  无 `/root` 等硬编码。
- **dsh-desktop**（[anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)）：
  插件作为普通 DSH 插件在桌面壳内照常工作。

## 安装

### 推荐：官方 CLI（包自带挂载层）

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/<name>
```

插件包声明了 `dsh.bundle.patch`，CLI 安装时会把它加进 `dsh.profile.bundles`，启动时自动合并
它自带的 patch 层，无需手改 profile，装完就出现在「插件」页的「已安装」里。部署自己的配置在
`$DSH_HOME/profiles/web/cordis.patch.yml` 里按行 id 覆盖（见各插件 README）。

### 备选：集合 patch（手动挂）

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

或把 [cordis.patch.yml](cordis.patch.yml) 的内容并入你的 profile 的
`$DSH_HOME/profiles/web/cordis.patch.yml`（配置 HMR 实时生效，无需重启）。

> 两种方式**二选一**：包已经进了 `dsh.profile.bundles` 再用集合 patch 的 insert 行挂一次，
> 就是同一个插件装两遍，插件树会因重复注册启动失败。

> 注意：插件依赖的 `@deepseek-ai/*` / `cordis` 由 dsh 官方运行时经 profile pnpm 闭包注入，
> **不要**在插件 `package.json` 里声明这些依赖（官方未发布到公共 npm，声明反而解析失败）。
> 例外：类工具包（如 `@deepseek-ai/dsh-atomic-write`）可以声明，它不会作为服务注入。

详细步骤见 [docs/INSTALL.md](docs/INSTALL.md)。

## 仓库结构

```text
dsh-plugins/
├── cordis.patch.yml         # 手动挂法（insert 行）；与 CLI 安装二选一
├── docs/
│   ├── INSTALL.md           # 安装指南（独立 / 全部 / 配置）
│   └── CONTRIBUTING.md      # 新增插件规范
├── examples/                # 各插件独立安装示例
└── plugins/
    └── <name>/              # 每个插件 = 独立 npm 包
        ├── package.json     # main/exports + dsh.bundle / dsh.client 声明
        ├── cordis.patch.yml # bundle 挂载层（insert 自己那一行）
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
