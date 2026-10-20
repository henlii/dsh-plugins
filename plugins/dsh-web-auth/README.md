<h1 align="center">dsh-web-auth</h1>

<p align="center">
  <strong>dsh web 内网 / LAN / Tailscale 访问的密码认证 + 信任插件</strong> — 非回环访问需密码登录；认证后设置、凭据等特权页面在内网可用。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

**推荐形态（0.6 起）：** webserver 绑回环（`127.0.0.1`），远程访问走本插件自带的手机入口
代理——代理监听 LAN/tailnet，密码通过后把 `Host`/`Origin` 改写成上游回环再转发（HTTP 与
WebSocket 都转发）。桌面端只探回环，这样它与远程访问可以并存，也不再依赖「认证后回环
外观」那套改写。

下面描述的是另一种形态（webserver 直接绑网卡地址，由本插件在认证后把请求呈现为回环），
仍然支持，但要求那个地址本来就允许外部直连。

dsh web 绑一个可达的网卡地址（内网 / Tailscale）后，其它设备就能直接连 `/api`，但
官方的浏览器信任栅栏**不是认证层**，且设置、凭据等特权方法（`PRIVILEGED_METHODS`）
被钉死在回环 Host。本插件补上这一层：

1. 给非回环的 `/api` 与 WebSocket 流量加**密码认证**，按真实 socket 对端地址判定，
   Host 头与 `X-Forwarded-For` 伪造无法绕过；
2. 认证通过后让特权方法在内网放行（**信任**）；
3. 顺带修复 LAN 页面的 `crypto.randomUUID` 缺失（非 secure context）与客户端
   `isLoopback` 作用域判定；
4. 在插件页（以及「设置 → 访问认证」整页）提供**绑定地址 + 端口**控制，不必再手改
   profile patch 或靠启动参数换 `--port`。

回环（`127.0.0.1` / `::1`）访问免密，方便本机运维。

## 安装

本包自带 `dsh.bundle.patch`（同目录 `cordis.patch.yml`），所以 **`dsh plugin add` 一条命令
就完成安装 + 挂载**：CLI 会把它加进 profile 的 `dsh.profile.bundles`，启动时自动合并自带的
patch 层，插件随之出现在「插件」页的「已安装」里。

```sh
# 从本仓库目录安装
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-auth

# 或从 npm 安装（已发布的话）
dsh plugin --profile web add @henlii/dsh-web-auth
```

挂载行 id 是 `web-auth`。部署自己的配置，在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: web-auth
  config:
    passwordFile: /home/you/.config/dsh/web-auth.password
    tokenTtlHours: 168
```

> 别同时又用仓库根 `cordis.patch.yml` 的 `insert` 行挂它：两边都挂就是同一个插件装两遍，
> 插件树会因重复注册启动失败。`insert` 挂法只留给"不把包加进 `dsh.profile.bundles`"的手动场景。

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `password` | 环境变量 `DSH_WEB_AUTH_PASSWORD` | 访问密码；留空则回退到 `passwordFile` |
| `passwordFile` | `<dsh 配置目录>/web-auth.password` | 密码文件（0600），**优先于** `password`，每次登录实时读取，改完即生效 |
| `tokenTtlHours` | `12` | 会话 token 有效期（小时） |
| `tokenFile` | `<dsh 配置目录>/web-auth-tokens.json` | 已签发 token 的持久化文件，服务重启不踢下线 |
| `lanHosts` | 自动从 `webStartup.trustedHosts` 派生 | 额外视为回环的 LAN / Tailscale 主机名（客户端 `isLoopback` 补丁用）。dsh 0.2.1-rc.2 之前这个服务叫 `webRuntime`，插件两个名字都认 |
| `builtinLoopbackPaths` | `true` | 内置的自围栏插件路径（`/api/task-board`、`/api/dsh-skill-explorer`）。命中的已认证 LAN 请求呈现回环外观，装插件即可用；设为 `false` 清空内置清单 |
| `trustLoopbackPaths` | `[]` | 额外路径前缀列表，在 `builtinLoopbackPaths` 之上追加。适合其他自带「仅限回环」围栏、且不依赖宿主 authority cookie 的第三方路由 |
| `extraProtectedPaths` | `[]` | 额外拉进密码门的非 `/api` 路径（默认 `/api` 已全部在门后） |
| `mobile` | `{ enabled: true, host: "0.0.0.0", port: 3081 }` | 手机入口代理的监听地址与端口；密码沿用 `password`/`passwordFile`。`enabled: false` 关闭。面板的「Web 访问」可开关、改端口并列出可访问地址，不暴露本地回环保定 |

`<dsh 配置目录>`：`DSH_HOME` 优先，Windows 为 `%APPDATA%\dsh`，其余为
`$XDG_CONFIG_HOME/dsh`（通常 `~/.config/dsh`）。

## 服务绑定（端口 / 绑定地址）

「插件」页 → 已安装 → `@henlii/dsh-web-auth`，改密码的下面就是绑定控制；同一张卡片也是
设置里的独立一页「访问认证」（与「dsh 更新」同一种席位）。

- **绑定地址**：下拉框，列出本机网卡地址（IPv4 在前，含回环）。候选由**跑着的
  `dsh-host-webserver` 自己的 host schema** 逐个过滤，所以列出来的都是当前版本真的
  接受的值。dsh 0.2.1-rc.2 起该 schema 只接受本机某个具体 IPv4/IPv6 字面量，`0.0.0.0`
  与 `::` 被拒（官方理由：通配绑定等于把带 RCE 的 API 摆到整个网络上），下拉里也就不再
  出现通配；更早的版本反过来只接受 `127.0.0.1` / `0.0.0.0`，那时通配仍可选。
- **端口**：`0-65535`，`0` 表示交回系统随机分配。
- **当前访问地址**：一行提示，取当前页面的 origin（你在哪个地址访问就显示哪个），改
  端口后与「打开新地址」对照。

保存走官方 `ctx.configEditor.edit()`：它把 `webserver` 行的下一份 config 写进**当前
profile 的 `cordis.patch.yml`**，再由 Loader reconcile 重启 webserver fiber。因此：

- 绑定地址变化时，会**同时**把新地址写进官方 `connection` 行的 `trustedHosts`。dshmarket
  这类第三方插件只读该字段判定请求 authority（宿主自己有 bind 地址兜底，它们没有），
  空数组会让它们的变更路由全部 403 `untrusted origin`。通配绑定推导不出对外 authority，
  不写入（响应带 `trustedHosts.reason`）；该行被 home patch / CLI overlay 覆盖时写入会被
  configEditor 拒绝，绑定本身仍会保存（响应带 `trustedHosts.ok = false` 与原因）。

- 保存后浏览器**多半收不到响应**——fiber 重启会关掉旧监听和所有连接，本页 WebSocket
  一起断。面板把这种断连按「已提交」处理，改端口时给出新地址并探测它是否真的起来。
- **只填写你改过的键**：只改绑定地址时，`port: !!js ctx.webStartup.port ?? 3080` 这类
  表达式原样保留（`--port` 继续有效）；一旦改了端口就写成字面量，此后 `--port` 不再
  影响它。想恢复「跟随启动参数」，在 profile patch 里把该键改回 `!!js` 表达式即可。
- 端口被占用在写文件**之前**就被预检拦下（409），不会留下坏配置；其它 reconcile 失败
  由 configEditor 自动回滚 patch 并重新加载旧配置。
- 该行若还被 home patch 或命令行 `--patch` overlay 覆盖，configEditor 会**拒绝写入**
  （面板显示原因），因为写进去也不生效。
- `0.0.0.0` 会把带 RCE 能力的 API 摆到网络上（官方 CLI 因此拒绝 `--host 0.0.0.0`）。
  改之前请确认访问密码已配置：没有密码时 `/api` 对全网络开放。

## 能力

| 能力 | 说明 |
|------|------|
| 密码登录 | 非回环 `/api` 与 WebSocket 需 `POST /api/auth/login` 下发的 HttpOnly cookie |
| 特权信任 | 认证后请求保留浏览器真实 authority（仅补同源 Origin/Referer、清 cross-site 标记），`settings`/`credentials`/`agentPreset`/模型发现等特权方法内网可用 |
| 登录浮层 | 纯 DOM 全屏登录卡片，不依赖应用外壳插槽，未登录时必然可见 |
| 登录限速 | 按真实 TCP 对端地址滑动窗口计数：5 次失败锁 60 秒，另有全局阈值防分布式；锁定期间正确密码也拒绝（429 + `Retry-After`） |
| 路由清扫 | profile 组装时先于本行注册的 `/api` 路由也能被纳入密码门（它们不经过被接管的 `webServer.register`） |
| 自围栏路由回环外观 | 已认证 LAN 会话访问**内置清单**（`/api/task-board`、`/api/dsh-skill-explorer`）或 `trustLoopbackPaths` 命中的路由时呈现回环外观，装插件即可用；socket 影子在响应结束时立即摘掉。**不适用于依赖宿主 `connection.requestRejection` 的路由**（如 `/api/dsh-update/*`）：宿主的浏览器 cookie 名与签名负载都绑定真实 authority，改写 Host 会让它 401 |
| 客户端 bundle 补丁 | 在 `/plugins` 组合响应体上，把连接客户端的 `isLoopbackHostname` 判定扩到本部署的 LAN / Tailscale 主机名，让 LAN 页面走 host 设置作用域。保留官方对 revision / HEAD / 404 / content-type 的判定，压缩交给官方 `webserver.compression` 中间件 |
| 官方 index 握手 | 非回环 index 请求在**宿主自己的判定**（`connection.requestRejection`）返回 401 时补上官方启动 token，由宿主自行种下浏览器 cookie；判定通过则原样放行（不多一次跳转，也不会成环）。因此浏览器里留着失效的 `dsh-auth-*` cookie（异 authority／端口、或密钥已轮换）时能自动恢复，而不是永久停在官方那句 401 原文上 |
| UUID polyfill | 通过 `tapIndex` 注入 `crypto.randomUUID` 补丁（LAN 非 secure context） |
| token 持久化 | 会话 token 落盘，服务重启不失效 |
| 插件页卡片 | 「插件」页 → 已安装 → `@henlii/dsh-web-auth` 详情页里的「访问认证」区块：改访问密码、绑定地址 / 端口、列出已登录会话（地址 / 时间）并删除某条登录 |
| 设置内独立页 | 与「dsh 更新」同一种席位（`settings.section`，order 45）：左侧设置导航单列「访问认证」，内容与插件详情页同一张卡片 |
| 服务绑定控制 | 绑定地址下拉 + 端口输入 + 当前访问地址提示；经官方 `configEditor` 写进 profile patch 并热重启 webserver，端口占用在写盘前预检 |
| 远程打开配置文件 | 遮罩官方「打开配置文件」按钮：点开一律在浏览器里弹出模态框查看 / 编辑 profile patch（复制 / 下载 / 保存，Ctrl+S）；宿主有桌面打开器时，模态框里多一个「在服务器本机打开」 |

## 安全边界

- 认证按**真实 TCP 对端地址**判定（`127.0.0.1`/`::1` 免密），Host 头与 `X-Forwarded-For` 伪造无法绕过；
- 静态资源（HTML/JS/CSS）不设密码门槛（页面本身无数据），`/api` 与 WebSocket 全在密码之后；
- 未通过密码认证的远程访客只拿到独立登录页；官方启动 token 仅在宿主判定为未认证的 index 握手时补一次，不预先发放给访客；
- 回环同样需要官方浏览器 cookie（官方设计），本插件只在其上增加一层密码门；
- 密码是部署级秘密（环境变量 / 0600 文件），GUI 里只写不改读；
- `builtinLoopbackPaths` / `trustLoopbackPaths` 的回环外观只对**已认证**会话生效，未带 token 的请求仍然 401。它不提升信任级别：已登录的 LAN 会话本来就能改 settings / 凭据，这里只是让那些自带回环围栏的路由接受同一批人；
- 回环外观**不改写**官方 `/api` 前缀（RPC 通道）与依赖宿主 authority cookie 的路由：宿主的 `dsh-auth-*` cookie 名是 `sha256(authority)`、签名负载里也重复该 authority，改写 Host 会让校验必然失败（实测 `/api/dsh-update/*` 会返回 401 `authentication required`）。所以默认只覆盖已知自围栏插件，其余按需用 `trustLoopbackPaths` 追加；
- socket 对端地址是逐请求影子：响应结束（`finish`/`close`）立即摘掉，keep-alive 后续请求按真实对端判定；
- 绑定控制不绕过官方校验：面板只把选择交给官方 `configEditor`，由它验证候选值、原子写 patch、失败回滚；能改它的会话本来就能改 settings 与凭据（面板自身在密码门之后）。通配绑定（旧版 dsh 上仍可选）的后果与官方 `--host 0.0.0.0` 完全相同，因此该控制与密码配置是一体的；dsh 0.2.1-rc.2 起服务端本身已拒绝通配绑定。

## 版本兼容

面向 dsh **0.2.1-rc.2**（0.1.7-rc.2 起可用）；0.2.1-rc.2 的两处不兼容改动已适配（见下）。

- 插件卡片挂在「插件」页 → 已安装 → 本插件详情页的 `plugins.detail.section` 槽；
- 客户端取用 `configForms` / `remote` / `remote.settings` 服务，宿主侧用 `settings.prepareDocument`；
- 不再依赖 `@deepseek-ai/dsh-settings`（该包的 `installSettingsSection` 在 0.1.7 已移除），
  设置卡片改由客户端自己注册到插件页；
- 旧版 dsh 的 keyed 设置槽 `settings.plugin.item` 与客户端 `settingsScope` 服务在 0.1.7 已不存在。

绑定控制另需宿主提供 `ctx.configEditor`（`dsh-base` 的 `config-editor` 行）：缺失时
面板把控件禁用并显示原因，认证本身不受影响。设置里的独立页注册在 `settings.section`
（由 `dsh-client-ui-sidebar` 声明）；槽未声明或对应包不在时该页不出现，插件详情页的
卡片照旧。

### dsh 0.2.1-rc.2

- `webRuntime` 服务改名 `webStartup`（`trustedHosts` 字段不变）。插件先读
  `webStartup`，读不到再退回 `webRuntime`，两个版本的宿主都能用。
- `dsh-host-webserver` 的 `host` schema 从「`127.0.0.1` / `0.0.0.0` 两个常量」改成
  「本机某个具体 IPv4/IPv6 字面量」，`0.0.0.0` / `::` 一律拒绝。绑定下拉因此改为按
  schema 过滤本机网卡地址。

升级到这里时，如果 profile patch 里还写着 `host: 0.0.0.0`，启动会失败：

```
webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is not supported
```

`webserver` 是 required 插件，它激活不了会让所有等 `webServer` / `connection` 的插件
（本插件、侧边栏、任务板、技能中心等）一起停在「等待服务」，整个 web 端起不来。改成
本机某个具体地址即可（例如 Tailscale 的 `100.x.y.z` 或内网 `192.168.x.y`）。

## License

[MIT](../../LICENSE) © 2026 Henry Li
