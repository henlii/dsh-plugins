# dsh-auto-update

DeepSeek Harness (dsh) 一键更新插件：在「设置 → 插件配置」卡片里检查 npm
正式版 / 预览版，后台升级 dsh 运行时，升级失败可一键回退。

## 为什么需要它

官方 dsh **没有**自更新命令（`dsh` CLI 只有 `--profile` / `web` / `plugin` 三种
模式），升级只能手动 `pnpm add -g @deepseek-ai/dsh@latest`。本插件把升级做成
带护栏的 web 流程。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-auto-update
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

```yaml
- insert:
    - id: auto-update
      name: 'dsh-auto-update'
      config: {}
```

## 使用

设置 → 插件配置 → **dsh-auto-update** 卡片：

- **升级到正式版**：安装 npm `latest` dist-tag；
- **升级到预览版**：安装 npm `next` dist-tag（体验新功能，可能不稳定）；
- **回退到上一版本**：装回升级前的版本（状态文件 `$DSH_HOME/dsh-auto-update.json`
  记录 `previous`）。

## 升级护栏（防卡死 / 防崩溃）

1. **独立子进程**：升级在 detached 的 `scripts/upgrade.mjs` 里执行，宿主进程
   不阻塞——安装期间 web 服务照常响应；
2. **先验证再重启**：安装完成后校验新版本 `package.json` 版本号与 `bin` 语法，
   通过才重启；失败则保持旧版本继续运行，卡片显示失败原因；
3. **重启安全**：systemd 部署自动 `systemctl restart dsh`（延迟 4s 让 HTTP 响应
   落地）；非 systemd 只提示手动重启，**绝不自杀式退出**；
4. **回退脚本**：每次升级前写 `$DSH_HOME/dsh-auto-update-rollback.sh`（Windows
   为 `.cmd`），新版本启动失败可一键装回旧版；
5. **并发护栏**：升级进行中拒绝新的升级请求；安装超时（10 分钟）自动终止。

## 部署形态

- **npm / pnpm 全局安装**（`node_modules/@deepseek-ai/dsh` 可定位）：完整支持；
- **dsh-desktop / 内嵌部署**：检测到后自动禁用命令行升级（桌面宿主自带更新
  机制），卡片只显示说明。

## 配置

| 键 | 说明 | 默认 |
|----|------|------|
| `packageManager` | 强制使用 `pnpm` 或 `npm`（不设则按运行入口推断） | 自动 |
| `restartCommand` | 自定义重启命令（如 `systemctl restart dsh`） | 自动探测 systemd |

## 已知取舍

- 升级目标为 npm dist-tag（`latest` / `next`），不锁定具体版本号；
- 回退锚点是「升级前的版本」，多次升级后回退到最近一次升级前；
- 升级需要全局包管理器写权限（root / 管理员）。
