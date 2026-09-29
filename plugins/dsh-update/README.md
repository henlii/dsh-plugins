<h1 align="center">dsh-update</h1>

<p align="center">
  <strong>dsh 更新器</strong> — 在 Web GUI 里检查 DeepSeek Harness 的发布通道、浏览与检索版本历史、一键升级到目标版本，并独立重启服务。<br/>
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license" /></a>
</p>

---

## 简介

`dsh` 没有自更新子命令（`dsh --help` 只有 profile 启动与 `dsh plugin add`），所以升级
只能手工（`npm install -g @deepseek-ai/dsh@<版本>` 或对应的 pnpm / yarn / bun 命令）再重启
服务。本插件把这两步搬进界面：**先检测这份 dsh 是怎么装的，再用同样的方式更新它**，并
**把升级和重启做成两个独立按钮**——换掉安装目录不会影响正在跑的进程，何时付出重启的代价
（会断开当前页面）由你决定。

界面有两个入口，同一张卡片：

- **设置 → dsh 更新**（独立设置页，推荐入口）
- **插件 → 已安装 → @henlii/dsh-update**（详情页内的一块）

| 能力 | 说明 |
|---|---|
| 检查更新 | 并行查两个来源，卡片上标出各自是否可达；10 分钟内命中缓存，「重新检查」强制刷新 |
| 安装方式检测 | 自动识别当前 dsh 是 npm / pnpm / yarn / bun 全局装、profile 本地装，还是源码树，并用**对应**的方式更新；卡片显示检测结果 |
| 通道切换 | `latest` / `next` / `alpha` 三个 npm dist-tag，切换即持久化，重启后仍是所选通道 |
| 近期版本 | 列出最多 40 个版本（新→旧），带通道标签、预发行标记、发布日期与 GitHub release 链接 |
| 检索版本 | 按版本号子串或通道标签筛选（`0.1.7`、`rc`、`0.2`）；无匹配返回空列表，不是报错 |
| 更新到指定版本 | 每行「装这个」直接装该版本；也可用顶部按钮装当前通道的最新版 |
| 升级后自动重启 | 安装成功即自动重启让新版本生效（默认），顺带消除「进程跑旧代码、页面收到新 bundle」的白屏中间态；`autoRestart: false` 可关掉 |
| 手动重启服务 | 独立「重启服务」按钮，用于你想自己挑时机的场景 |
| 安装进度 | 展示检测到的安装方式、实际命令、实时日志与已用时间；静默超时 10 分钟，慢镜像不会被误杀 |

## 安装方式检测

更新命令必须匹配**当前这份** dsh 的安装方式：对 pnpm/yarn 管理的树跑 `npm install -g`，
要么失败要么写出第二份运行进程永远读不到的副本。检测按路径形状判定，并用「问管理器自己是否
拥有这份安装」交叉确认——**不能只靠标记文件**：npm 全局树只有在 `package-lock` 开启时才写
`.package-lock.json`，本机就没有，靠它判断会误判。

| 检测结果 | 路径特征 | 更新命令 |
|---|---|---|
| npm 全局 | `<prefix>/lib/node_modules/@deepseek-ai/dsh` | `npm install -g <spec> --prefix <prefix>` |
| pnpm 全局 | `$PNPM_HOME/global/<大版本>/<hash>/node_modules/...` + 同级 `pnpm-lock.yaml` | `pnpm add --global <spec>`（带 `PNPM_HOME`） |
| yarn 全局 | `~/.config/yarn/global/node_modules/...` | `yarn global add <spec>` |
| bun 全局 | `~/.bun/install/global/node_modules/...` | `bun add --global <spec>` |
| profile 本地 | `$DSH_HOME/profiles/<名>/node_modules/...` | 在该 profile 目录内 `pnpm add <spec>` |
| 源码树 | 祖先目录同时含 `pnpm-workspace.yaml` 与 `.git` | **拒绝**，提示 `git pull && pnpm install` |

两个刻意的取舍：

- **只管当前运行副本。** 即使本机存在多份 dsh，也只更新正在跑的那一份（用 `process.argv[1]`
  与模块路径定位），不会去改其它 nvm 版本或 profile 的副本。
- **严格只用检测到的管理器。** 检测到 npm 但没有可用的 npm 命令时，直接报错并给出该执行的
  命令，而不是自作主张换一个工具——换错工具可能留下第二份坏副本。

## 版本来源

| 来源 | 用途 |
|---|---|
| npm registry 的 `dist-tags` 与版本清单 | 主源：通道指向、可安装版本、发布日期 |
| GitHub Releases（`dsh-v*` tag） | 副源：registry 未镜像到的版本、更新说明、release 链接 |

registry 地址取自**拥有这份安装的那个管理器**的 `config get registry`（本机为
`https://registry.npmmirror.com`），与它实际安装所用的源保持一致——插件查 npmjs 而管理器从
镜像装，是这类工具最常见的错配。两个来源都不可达时卡片会明说「无法判断」，而不是假装是最新。

## 安装

包自带 `dsh.bundle.patch`，官方 CLI 一条命令装完即挂载：

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-update

# 或从 npm
dsh plugin --profile web add @henlii/dsh-update
```

手动挂法见本仓库根的 `cordis.patch.yml`，两种方式**二选一**（同时用会双挂载，插件树启动
失败）。配置项只有两个，见包内 `cordis.patch.yml`：

```yaml
- id: dsh-update
  config:
    channel: latest      # 初值；界面切换后以持久化状态为准
    autoCheck: true      # 每 30 分钟后台检查一次，不安装
    autoRestart: true    # 安装成功后自动重启；设为 false 恢复两按钮手动流程
```

## 接口

所有路由（含只读）都先过宿主的 API 栅栏 `connection.requestRejection`，再做同源判定。
插件的路由注册为 `kind: "exact"`，而宿主把官方栅栏挂在 `/api` **前缀**路由上、exact 表优先命中，
所以官方检查不会自动跑——必须显式调用（官方插件注册 exact `/api` 路由时同样这么做）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-update/status` | 当前版本、通道、各来源最新版、版本列表、更新与重启状态 |
| GET | `/api/dsh-update/versions?q=` | 版本历史；`q` 按版本子串或通道标签筛选 |
| POST | `/api/dsh-update/check` | 强制重新检查（跳过 10 分钟缓存） |
| POST | `/api/dsh-update/channel` | `{ channel }` 切换并持久化通道 |
| POST | `/api/dsh-update/update` | `{ version? }` 安装指定版本；省略则装当前通道最新版 |
| POST | `/api/dsh-update/restart` | 重启当前 dsh 实例 |

## 实现要点

- **重启分两条路径**。cgroup 里同时存在 `user@1000.service` 和 `dsh.service`，正则会先匹配
  到用户管理器（`MainPID=0`），所以插件遍历 cgroup 中**全部** `.service` 候选并逐个比对
  `systemctl --user show -p MainPID`，只重启 `MainPID` 等于自身 PID 的那个。没有 systemd
  托管时（手工 `dsh web` 启动）落到看门狗脚本：先 `SIGTERM`、限时后 `SIGKILL`，确认端口
  释放再用**原始命令行**重新拉起。脚本必须自己结束目标进程——普通 dsh 不会自行退出，只
  「等 PID 消失」的重启会静默什么也不做。
- **安装位置解析要穿透软链**。本仓库插件是以 `link:` 安装的，`import.meta.url` 的 realpath
  指向源码仓库，向上永远找不到 dsh 包。插件同时走原始路径与 realpath，并以
  `process.argv[1]`（`bin/dsh` 软链，realpath 后是 `lib/bin.js`）与前缀推导为准。
  运行副本的实际版本从安装目录的 `package.json` 读取，不硬编码。
- **scoped 包名多一层路径**。`<node_modules>/@deepseek-ai/dsh` 里的 scope 让
  `node_modules` 位于**上两级**而非上一级；少算一层会让 npm 全局布局被判成「无法判定」。
- **`-g` 必须是标志，不能写成位置参数 `global`**。`npm install global <pkg> --prefix P`
  会被 npm 理解成「安装名为 `global` 的包」（真的会去下载 `global@4.x`），且 `--prefix`
  使其变成 **local** 安装（`P/node_modules/...` 而非 `P/lib/node_modules/...`），全局什么
  都没更新。已按 npm 11 实测校正，并在单测里断言 `-g` 存在、位置参数 `global` 不存在。
- **目标版本先解析再交给管理器**。`/update` 接受通道名或精确版本号，两者都要在刚刷新过的
  来源清单里存在才放行；`0.1.7-rc.2; rm -rf /` 这类输入到不了命令行（且参数始终是独立
  argv，不经过 shell）。
- **升级失败不改动旧安装**。管理器在新版本完整安装前保留旧版本；安装后若运行副本版本没变
  （装到了另一个 dsh 副本），插件报失败而不是谎报成功。
- **归属判定比路径，不比包名**。`npm ls -g --json` 的输出里**没有路径**
  （只有 `{"name":"lib","dependencies":{...}}`），所以用「输出里出现包名」判断归属会对
  *任何* root 都返回真——多副本时会把更新指向错误那一份。改为向管理器要它自己的全局根，
  再比较运行副本是否真的在其 `node_modules` 之下。
- **exact 路由必须自己补宿主栅栏**。宿主把官方 API 栅栏挂在 `/api` 前缀路由上，而
  `WebServer.match()` 先查 exact 表，命中即返回——插件自己的 6 条路由**不会**自动过那道检查。
  不补的话，任何能让受害者浏览器访问到该端口、且未同时部署 `dsh-web-auth` 的实例都会被跨站
  触发全局安装与重启。现在 6 条路由全部显式调用 `connection.requestRejection`（并如实回传其
  401/403）。
- **同源判定必须比完整 authority（含端口）**。只比主机名会放行「同主机另一个端口上的页面」
  （`http://127.0.0.1:9999` vs `Host: 127.0.0.1:3080`），而这是攻击者可达的位置；同时识别
  `Sec-Fetch-Site: cross-site`，因为跨站简单 POST 不需要预检。
- **版本串必须锚定校验**。`parseVersion` 原先是非锚定前缀匹配，`0.1.7-rc.2; rm -rf /`、
  `0.1.7-../../../../tmp/evil` 都能通过，而它们会被拼进 `@deepseek-ai/dsh@<版本>`。虽然
  `shell:false` 让 shell 元字符无害，但 npm 把它当 **directory spec**——实测会建出
  `dsh -> ../../../../tmp/evil`。现在正则锚定 + 规范化回比，GitHub release tag（外部输入）
  走同一道校验，`buildVersionList` 再复核一次。
- **源码树判据要求包不在 `node_modules` 下**。否则把 `DSH_HOME` 纳入 dotfiles 仓库、而仓库根
  恰好有 `pnpm-workspace.yaml` 时，profile 安装会被误判成源码树并拒绝更新（功能不可用）。
- **看门狗脚本写在 `mkdtemp` 私有目录**。固定名 + 世界可写的 `/tmp` 可被其他本地用户预先放成
  符号链接，而 `writeFileSync` 会跟随它覆盖任意可写文件。
- **同步子进程结果要缓存**。`npm config get registry` 在本机阻塞约 140ms，且 `/status` 在安装
  期间被每 2 秒轮询——实测缓存后每次从 149ms 降到 9ms。缓存随强制检查失效。
- **异步 spawn 失败要有监听**。`setsid`/`systemctl` 缺失时 `error` 事件异步到达，无监听会
  **直接终止 dsh 进程**；现在记录并让重启路由如实返回失败，而不是谎称已触发重启。
- **升级后默认自动重启**。换掉安装目录不影响运行进程，但**不重启就会坏**：客户端 bundle
  是服务端按磁盘 `readFileSync` 实时提供的，于是进程跑旧代码、浏览器却拿到新 bundle，
  版本错配导致页面加载失败（实测白屏）。所以安装成功后自动重启是默认行为，`autoRestart: false`
  才回到手动两按钮流程。重启复用与手动按钮完全相同的路径（systemd 优先、看门狗兜底），
  失败时如实回传错误并提示手动重启。
- **安装命令的 cwd 不用 `$HOME`**。万一某管理器退化成局部安装，破坏应落在临时目录，
  而不是往家目录写 `node_modules`/`package.json`/`package-lock.json`。

## 验证

```sh
node scripts/test-updater.mjs   # 版本比较/规范化、版本列表、目标解析、安装方式判定、命令构造、归属判定（54 项）
node scripts/test-routes.mjs    # API 栅栏与同源判定、检索、并发互斥、写入保护（20 项）
```

两组检查都不联网、不启动 dsh、不触碰任何包管理器，且在临时 `DSH_HOME` 内运行（否则会把
`channel` 写进操作者真实的 DSH 配置）。变异测试确认关键断言有效：退回按主机名比较、去掉版本
锚定、还原 `-g` 位置参数、禁用并发锁，都会让检查失败。

真实环境冒烟（隔离 `DSH_HOME` + 独立端口）验证过：本机被正确识别为「npm 全局」，
前缀与 npm CLI 路径准确，运行版本读作 0.1.7-rc.2。
