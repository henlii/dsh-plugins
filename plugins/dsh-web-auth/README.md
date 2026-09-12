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

## 安装

**独立安装：**

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-auth
```

**或全部安装（集合）：**

```sh
dsh web --patch /path/to/dsh-plugins/cordis.patch.yml
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 增加（或确认已在集合 patch 中）：

```yaml
- insert:
    - id: web-auth
      name: 'dsh-web-auth'
      config:
        password: !!js process.env.DSH_WEB_AUTH_PASSWORD
        tokenTtlHours: 12
```

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `password` | 环境变量 `DSH_WEB_AUTH_PASSWORD` | 访问密码；留空则回退到 `passwordFile` |
| `passwordFile` | `/root/.config/dsh/web-auth.password` | 密码文件（0600），**优先于** `password`，每次登录实时读取、改完即生效 |
| `tokenTtlHours` | `12` | 会话 token 有效期（小时） |
| `tokenFile` | `/root/.config/dsh/web-auth-tokens.json` | 已签发 token 持久化文件（服务重启不踢下线） |
| `lanHosts` | 自动从 `webRuntime.trustedHosts` 派生 | 额外视为回环的 LAN/Tailscale 主机名（客户端 `isLoopback` 补丁用） |

## 能力

| 能力 | 说明 |
|------|------|
| 密码登录 | 非回环 `/api` 与 WebSocket 需 `POST /api/auth/login` 下发的 HttpOnly cookie |
| 特权信任 | 认证后请求保留浏览器真实 authority（仅补同源 Origin/Referer、清 cross-site 标记），`settings`/`credentials`/`agentPreset`/模型发现等特权方法内网可用 |
| 登录浮层 | 纯 DOM 全屏登录卡片（不依赖应用外壳插槽），未登录时必然可见 |
| 登录限速 | 按真实 TCP 对端地址滑动窗口计数：5 次失败锁 60 秒，另有全局阈值防分布式；锁定期间正确密码也拒绝（429 + `Retry-After`） |
| 客户端 bundle 补丁 | 在 `/plugins` 组合响应体上把连接客户端的 `isLoopbackHostname` 判定串扩到本部署的 LAN/Tailscale 主机名，让 LAN 页面走 host 设置作用域。保留官方对 revision/HEAD/404/content-type 的判定，压缩交给官方 `webserver.compression` 中间件 |
| UUID polyfill | 通过 `tapIndex` 注入 `crypto.randomUUID` 补丁（LAN 非 secure context） |
| token 持久化 | 会话 token 落盘，服务重启不失效 |
| 设置页卡片 | 改访问密码、列出已登录会话（地址/时间）并删除某条登录 |
| 远程打开配置文件 | 替换官方「打开配置文件」按钮：headless 服务器上改为大模态框查看/编辑 `settings.yaml`（复制/下载/保存，Ctrl+S）；宿主有桌面打开器时仍走官方原生打开 |

## 安全边界

- 认证按**真实 TCP 对端地址**判定（`127.0.0.1`/`::1` 免密），Host 头与 `X-Forwarded-For` 伪造无法绕过；
- 静态资源（HTML/JS/CSS）不设密码门槛（页面本身无数据），`/api` 与 WebSocket 全在密码之后；
- 未通过密码认证的远程访客只拿到独立登录页；官方启动 token 仅在 index 握手时补一次，不预先发放给访客；
- 回环同样需要官方浏览器 cookie（官方设计），本插件只在其上增加一层密码门；
- 密码是部署级秘密（环境变量/0600 文件），不写入 GUI 明文编辑。

## 插件管理

已装插件推荐用 [plugin-registry](https://github.com/vlln/plugin-registry) 的**薄控制台**
管理安装态，无需手改配置：

```sh
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```

## License

[MIT](../../LICENSE) © 2026 Henry Li
