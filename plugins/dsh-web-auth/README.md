<h1 align="center">dsh-web-auth</h1>

<p align="center">
  <strong>dsh web 内网/LAN/Tailscale 访问的密码认证 + 信任插件</strong> — 非回环访问需密码登录；认证后设置/凭据等特权页面在内网可用。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

dsh web 直绑 `0.0.0.0`（方案 B）后，内网设备可直接连 `/api`，但 dsh 官方的浏览器信任栅栏
**不是认证层**，且设置/凭据等特权方法（`PRIVILEGED_METHODS`）被钉死在回环 Host。本插件：

1. 给非回环的 `/api` 与 WebSocket 流量加**密码认证**（按真实 socket 对端地址判定，无法伪造）；
2. 认证通过后把请求改写为回环外观，让特权方法在内网放行（**信任**）；
3. 顺带修复 LAN 页面缺失 `crypto.randomUUID`（非 secure context）与
   客户端 `isLoopback` 作用域问题。

回环（127.0.0.1）访问免密，方便本机运维。

## 版本兼容

面向 dsh **0.1.7-rc.2**（插件卡片挂在官方「插件」页 → 已安装 → 本插件详情页的
`plugins.detail.section` 槽，服务用 `configForms`/`remote.settings`；宿主侧用
`settings.prepareDocument`）。旧版 dsh 的 keyed 设置槽 `settings.plugin.item` 与
`settingsScope` 服务在 0.1.7 已不存在；插件不再依赖 `@deepseek-ai/dsh-settings`
（该包的 `installSettingsSection` 已移除），卡片改由客户端自己注册到插件页。

## 安装

本包自带 `dsh.bundle.patch`（见 `cordis.patch.yml`），所以 **`dsh plugin add` 一条命令
就完成安装 + 挂载**：CLI 会把它加进 `dsh.profile.bundles`，启动时自动合并自带的 patch 层，
插件随之出现在「插件」页的「已安装」里。

```sh
# 本仓库目录
 dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-auth

# 或 npm 包（已发布的话）
dsh plugin --profile web add @henlii/dsh-web-auth
```

挂载行 id 是 `web-auth`，部署自己的配置在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: web-auth
  config:
    passwordFile: /home/you/.config/dsh/web-auth.password
    tokenTtlHours: 168
```

> 不要同时又用仓库根的 `cordis.patch.yml` 的 `insert` 行挂它：两边都挂就是同一个插件装两遍，
> 插件树会因重复注册启动失败。旧的 `insert` 挂法只在“只用集合 patch、不把包加进
> `dsh.profile.bundles`”时保留。

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `password` | 环境变量 `DSH_WEB_AUTH_PASSWORD` | 访问密码；留空则回退到 `passwordFile` |
| `passwordFile` | `/root/.config/dsh/web-auth.password` | 密码文件（0600），**优先于** `password`，每次登录实时读取、改完即生效 |
| `tokenTtlHours` | `12` | 会话 token 有效期（小时） |
| `tokenFile` | `/root/.config/dsh/web-auth-tokens.json` | 已签发 token 持久化文件（服务重启不踢下线） |
| `lanHosts` | 自动从 `webRuntime.trustedHosts` 派生 | 额外视为回环的 LAN/Tailscale 主机名（客户端 `isLoopback` 补丁用） |
| `trustLoopbackPaths` | `[]` | 前缀列表（如 `/api/dsh-skill-explorer`）：密码认证通过的 LAN 请求在这些路径上呈现回环外观，供第三方「仅限回环」路由使用 |
| `extraProtectedPaths` | `[]` | 额外拉进密码门的非 `/api` 路径（如第三方插件在 `/vision-bridge/rpc` 这类路径上放敏感接口） |

## 能力

| 能力 | 说明 |
|------|------|
| 密码登录 | 非回环 `/api` 与 WebSocket 需 `POST /api/auth/login` 下发的 HttpOnly cookie |
| 特权信任 | 认证后请求保留浏览器真实 authority（仅补同源 Origin/Referer、清 cross-site 标记），`settings`/`credentials`/`agentPreset`/模型发现等特权方法内网可用 |
| 登录浮层 | 纯 DOM 全屏登录卡片（不依赖应用外壳插槽），未登录时必然可见 |
| 登录限速 | 按真实 TCP 对端地址滑动窗口计数：5 次失败锁 60 秒，另有全局阈值防分布式；锁定期间正确密码也拒绝（429 + `Retry-After`） |
| 客户端 bundle 补丁 | 在 `/plugins` 组合响应体上把连接客户端的 `isLoopbackHostname` 判定串扩到本部署的 LAN/Tailscale 主机名，让 LAN 页面走 host 设置作用域。保留官方对 revision/HEAD/404/content-type 的判定，压缩交给官方 `webserver.compression` 中间件 |
| 官方 index 握手 | 非回环 index 请求在**宿主自己的判定**（`connection.requestRejection`）返回 401 时补上官方启动 token，让宿主自行种下浏览器 cookie；判定通过则原样放行（不多一次跳转，也不会成环）。因此浏览器里留着失效的 `dsh-auth-*` cookie（异 authority／端口、或密钥已轮换）时能自动恢复，而不是永久停在官方那句 401 原文上 |
| UUID polyfill | 通过 `tapIndex` 注入 `crypto.randomUUID` 补丁（LAN 非 secure context） |
| token 持久化 | 会话 token 落盘，服务重启不失效 |
| 路由清扫 | profile 组装时先于本行注册的第三方 `/api` 路由也会被纳进密码门（它们不经过被接管的 `webServer.register`） |
| 受信路径回环外观 | `trustLoopbackPaths` 里列出的前缀，对已认证 LAN 会话呈现回环外观（Host / Origin / socket 对端地址），第三方「仅限回环」插件（如技能中心）在内网可用；socket 影子在响应结束时立即摘掉 |
| 插件页卡片 | 「插件」页 → 已安装 → `@henlii/dsh-web-auth` 详情页里的「访问认证」区块：改访问密码、列出已登录会话（地址/时间）并删除某条登录 |
| 远程打开配置文件 | 遮罩官方「打开配置文件」按钮：点开一律在浏览器里弹出模态框查看/编辑 profile patch（复制/下载/保存，Ctrl+S）；宿主有桌面打开器时，模态框里多一个「在服务器本机打开」（远程访客看不到服务器桌面，所以不作默认行为） |

## 安全边界

- 认证按**真实 TCP 对端地址**判定（`127.0.0.1`/`::1` 免密），Host 头与 `X-Forwarded-For` 伪造无法绕过；
- 静态资源（HTML/JS/CSS）不设密码门槛（页面本身无数据），`/api` 与 WebSocket 全在密码之后；
- 未通过密码认证的远程访客只拿到独立登录页（插件自身的 token 只在认证通过后签发）；官方启动 token 仅在宿主判定为未认证的 index 握手时补一次，不预先发放给访客；
- 回环同样需要官方浏览器 cookie（官方设计），本插件只在其上增加一层密码门；
- 密码是部署级秘密（环境变量/0600 文件），不写入 GUI 明文编辑；
- `trustLoopbackPaths` 只对**已认证**会话生效，且只影响列出的前缀；未带 token 的请求仍然 401。它不提升信任级别：已登录的 LAN 会话本来就能改 settings/凭据，这里只是让那些自带回环围栏的第三方路由也接受同一批人；
- socket 对端地址是逐请求影子：响应结束（`finish`/`close`）立即摘掉，keep-alive 后续请求按真实对端判定（已实测同一连接上紧随其后的无 cookie 请求仍为 401）。

## 插件管理

已装插件推荐用 [plugin-registry](https://github.com/vlln/plugin-registry) 的**薄控制台**
管理安装态，无需手改配置：

```sh
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```

## License

[MIT](../../LICENSE) © 2026 Henry Li
