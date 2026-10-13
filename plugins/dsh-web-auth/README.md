<h1 align="center">dsh-web-auth</h1>

<p align="center">
  <strong>dsh web 内网 / LAN / Tailscale 访问的密码认证 + 信任插件</strong> — 非回环访问需密码登录；认证后设置、凭据等特权页面在内网可用。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

dsh web 绑 `0.0.0.0` 后，内网设备可以直接连 `/api`，但 dsh 官方的浏览器信任栅栏
**不是认证层**，且设置、凭据等特权方法（`PRIVILEGED_METHODS`）被钉死在回环 Host。
本插件补上这一层：

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
| `lanHosts` | 自动从 `webRuntime.trustedHosts` 派生 | 额外视为回环的 LAN / Tailscale 主机名（客户端 `isLoopback` 补丁用） |
| `trustLoopbackPaths` | `[]` | 路径前缀列表。命中的前缀上，已认证的 LAN 请求呈现回环外观，用于自带「仅限回环」围栏的路由 |
| `extraProtectedPaths` | `[]` | 额外拉进密码门的非 `/api` 路径（默认 `/api` 已全部在门后） |

`<dsh 配置目录>`：`DSH_HOME` 优先，Windows 为 `%APPDATA%\dsh`，其余为
`$XDG_CONFIG_HOME/dsh`（通常 `~/.config/dsh`）。

## 服务绑定（端口 / 绑定地址）

「插件」页 → 已安装 → `@henlii/dsh-web-auth`，改密码的下面就是绑定控制；同一张卡片也是
设置里的独立一页「访问认证」（与「dsh 更新」同一种席位）。

- **绑定地址**：下拉框，只有 `127.0.0.1`（仅本机）与 `0.0.0.0`（所有网卡）两个取值
  ——官方 `dsh-host-webserver` 的 `host` schema 就是这两个常量，填具体网卡 IP 会被
  配置校验拒绝。
- **端口**：`0-65535`，`0` 表示交回系统随机分配。
- **当前访问地址**：一行提示，取当前页面的 origin（你在哪个地址访问就显示哪个），改
  端口后与「打开新地址」对照。

保存走官方 `ctx.configEditor.edit()`：它把 `webserver` 行的下一份 config 写进**当前
profile 的 `cordis.patch.yml`**，再由 Loader reconcile 重启 webserver fiber。因此：

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
| 受信路径回环外观 | `trustLoopbackPaths` 命中的前缀，对已认证 LAN 会话呈现回环外观（Host / Origin / socket 对端地址）；socket 影子在响应结束时立即摘掉 |
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
- `trustLoopbackPaths` 只对**已认证**会话生效，且只影响列出的前缀，未带 token 的请求仍然 401。它不提升信任级别：已登录的 LAN 会话本来就能改 settings / 凭据，这里只是让那些自带回环围栏的路由接受同一批人；
- socket 对端地址是逐请求影子：响应结束（`finish`/`close`）立即摘掉，keep-alive 后续请求按真实对端判定；
- 绑定控制不绕过官方校验：面板只把选择交给官方 `configEditor`，由它验证候选值、原子写 patch、失败回滚；能改它的会话本来就能改 settings 与凭据（面板自身在密码门之后）。切到 `0.0.0.0` 的后果与官方 `--host 0.0.0.0` 完全相同，因此该控制与密码配置是一体的。

## 版本兼容

面向 dsh **0.1.7-rc.2**：

- 插件卡片挂在「插件」页 → 已安装 → 本插件详情页的 `plugins.detail.section` 槽；
- 客户端取用 `configForms` / `remote` / `remote.settings` 服务，宿主侧用 `settings.prepareDocument`；
- 不再依赖 `@deepseek-ai/dsh-settings`（该包的 `installSettingsSection` 在 0.1.7 已移除），
  设置卡片改由客户端自己注册到插件页；
- 旧版 dsh 的 keyed 设置槽 `settings.plugin.item` 与客户端 `settingsScope` 服务在 0.1.7 已不存在。

绑定控制另需宿主提供 `ctx.configEditor`（`dsh-base` 的 `config-editor` 行）：缺失时
面板把控件禁用并显示原因，认证本身不受影响。设置里的独立页注册在 `settings.section`
（由 `dsh-client-ui-sidebar` 声明）；槽未声明或对应包不在时该页不出现，插件详情页的
卡片照旧。

## License

[MIT](../../LICENSE) © 2026 Henry Li
