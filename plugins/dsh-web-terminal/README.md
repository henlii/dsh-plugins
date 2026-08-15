# dsh-web-terminal (v2)

VS Code 式**全局独立终端**：终端与会话/工作区生命周期无关、不限制数量、会话↔终端
一对多、命令执行结束通知使用它的会话。终端 UI 在**右侧栏**（dsh-sidebar 的「终端」
tab）里，REPL 式直接输入，tab 标签切换多个终端。

> 本插件只负责宿主能力（ctx.shell 替换、终端管理、模型工具、RPC）；终端面板 UI
> 由 [dsh-sidebar](../dsh-sidebar/) 的「终端」tab 渲染。

## 模型

- **终端完全独立**：由稳定的 `terminal-host` 托管 agent 持有，数量不限，不随会话或
  工作区消亡；重启 dsh 后陈旧终端自动重建（NO_SESSION 自动 respawn + 服务端 reconcile）。
- **会话↔终端一对多**：会话的 `bash` 命令默认走会话的主终端（首次自动创建并关联）；
  会话可用 `terminal_new` / `terminal_send` 主动调用任意多个终端，shell 状态（cwd/
  env/后台任务）跨调用保持。
- **执行结束通知会话**：每次命令结束，向使用该终端的所有会话注入
  `【终端】命令执行结束（exit N）…` 通知；用户在 Web 的发送/中断/关闭也会通知。
- **所有预设都生效**：本插件**替换 `ctx.shell`**（禁 `dsh-bash-sandbox`），而所有
  预设共用的标准 `dsh-tool-bash` 是 `ctx.shell` 的消费者——不用改任何预设、不用选预设。
- **退出码**：行尾 `__DSH_RC__` 标记解析（与原生 `bash -c` 的「末条命令退出码」语义一致）。

## 安装（全新机器 4 步）

```sh
# 1. 安装插件包（从 git 拉取后需先在 dsh-plugins 工作区跑 pnpm install）
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-terminal

# 2. 在 $DSH_HOME/profiles/web/cordis.patch.yml 加：
#    - insert:
#        - id: pty
#          name: '@deepseek-ai/dsh-terminal'
#        - id: terminal-bash
#          name: '@deepseek-ai/dsh-terminal-bash'
#          config: { timeoutMs: 300000, disposeGraceMs: 500 }   # disposeGraceMs 让关闭终端秒回
#        - id: web-terminal
#          name: 'dsh-web-terminal'
#    - id: bash-sandbox
#      disabled: true

# 3. 重启
systemctl restart dsh.service

# 4. 刷新浏览器（Ctrl+Shift+R，客户端代码变更需刷新加载）
```

装好即用，无其他配置：`bash` 自动变持久、终端工具自动注册、Web 面板自动出现。

## 模型工具（agent 侧）

| 工具 | 作用 |
|---|---|
| `terminal_new` | 新建独立终端（可指定 name/cwd），返回 terminal_id |
| `terminal_send` | 在指定终端执行命令（等待结果，支持后台 job），shell 状态跨调用保持 |
| `terminal_list` | 列出所有终端（id/名称/状态/使用它的会话） |
| `terminal_kill` | 关闭终端并移除 |

## Web 面板（右侧栏）

- 位置：**右侧栏**（dsh-sidebar 的「终端」tab，rail 上 文件/Git/信息 之后新增终端图标）。
- **REPL 式**：点击终端直接输入，Enter 执行，Ctrl+C 中断——**没有独立的输入框和
  发送/中断/强杀按钮**；错误信息显示在输出区顶部。
- **tab 标签**：各终端 tab（本会话带 ★）、`+` 新建；点击 `×` 关闭。
- 输出区深色（#0d0f13/#d4d7e0），填满侧栏内容区。

## 路由（POST JSON，/api 自动受 web-auth 密码保护）

| 路由 | 参数 | 说明 |
|---|---|---|
| `/api/dsh-web-terminal/snapshot` | sessionId | 全部终端列表 + 本会话关联标记 |
| `/api/dsh-web-terminal/read` | sessionId, id, count? | 读取滚动回显 |
| `/api/dsh-web-terminal/send` | sessionId, id, text | 发送命令（自动确保终端存在） |
| `/api/dsh-web-terminal/signal` | sessionId, id, signal | SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP |
| `/api/dsh-web-terminal/kill` | sessionId, id | 关闭并移除终端 |
| `/api/dsh-web-terminal/spawn` | sessionId, name?, cwd? | 新建终端 |

## 已知取舍

- 「直接输入」是 **REPL 级**（逐行发送 + 回显），不是 xterm 级原始模式：harness 的
  `terminals` 服务是「发送-等待-就绪」模型，跑不了 vim/htop 这类全屏交互程序的实时
  原始键流；日常命令行完全够用，需要 xterm.js 级交互需另建 WebSocket 流通道。
- 后台 job（`run_in_background`）走一次性子进程（不需要终端持久性）。
- 终端按名称独立；同一目录的多会话各自记录使用关系。
