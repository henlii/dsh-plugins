# 安装指南

dsh-plugins 集合内的插件是独立的 npm 包（纯 cordis 插件形态，0811 官方规范）。
本文介绍两种安装方式：**独立安装**与**一次性全部安装**。

## 前置

- dsh 已安装（`dsh --version` 可用）
- web profile 存在（`$DSH_HOME/profiles/web/`，默认 `~/.dsh/profiles/web/`）
- 插件依赖的 `@deepseek-ai/*` / `cordis` 由 dsh 官方运行时注入，**无需**手动安装

## 方式一：一次性全部安装

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

或者把 [cordis.patch.yml](../cordis.patch.yml) 的内容并入：

```sh
$DSH_HOME/profiles/web/cordis.patch.yml   # 配置 HMR 实时生效，无需重启
```

> `--patch` 是 launcher 参数，会叠加在 profile 层之后；并入 profile patch 则随
> 配置文件热更新。两种方式等价，按部署习惯选。

## 方式二：独立安装单个插件

以 `dsh-web-auth` 为例：

```sh
# 1. 安装依赖包（本地目录或 git 源）
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-auth

# 2. 在 profile patch 中挂载（配置 HMR 实时生效）
#    $DSH_HOME/profiles/web/cordis.patch.yml 增加：
#    - insert:
#        - id: web-auth
#          name: 'dsh-web-auth'
#          config: { ... }
```

每个插件的具体配置项见其 `plugins/<name>/README.md`。独立安装示例见 `examples/<name>/cordis.patch.yml`（若有）。

## 配置 HMR

纯 cordis 插件经 profile `cordis.patch.yml` insert 行挂载，**配置 HMR 实时生效**：
修改 insert 行后无需重启 web。Node half 代码变更仍需重启 dsh 生效。

## 验证

```sh
# 插件行已挂载
curl -s http://127.0.0.1:3080/ | grep -o '<plugin 名>'   # 按实际插件核对

# 服务状态
systemctl status dsh.service   # 或你的 dsh 启动方式
```

详细挂载失败排查参考官方 [make-dsh-plugin install-and-verify](https://github.com/vlln/plugin-registry/blob/main/skills/make-dsh-plugin/references/install-and-verify.md)。
