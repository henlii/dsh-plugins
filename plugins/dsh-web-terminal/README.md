# dsh-web-terminal

用户侧栏的独立 PTY 终端。Agent 的 `bash` 走官方一次性 `ctx.shell`（`dsh-bash-sandbox`）；
本插件不替换执行器、不向模型注册 `terminal_*`。

终端 UI 在 [dsh-sidebar](../dsh-sidebar/) 的「终端」tab：REPL 式直接输入，tab 切换多个终端。

## 模型

- **只给用户**：PTY 由稳定的 `terminal-host` 作为 `ctx.terminals` 的 owner 持有（登记表技术约束），数量不限，不随会话消亡；重启后陈旧终端自动 respawn。
- **不接管 Agent shell**：标准预设的 `dsh-tool-bash` 仍吃官方 `ctx.shell`。
- **退出码**：用户发送的命令在行尾加 `__DSH_RC__` 标记，便于面板显示 exit code。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-web-terminal
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

```yaml
- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config: { timeoutMs: 300000, disposeGraceMs: 500 }
    - id: web-terminal
      name: 'dsh-web-terminal'
```

不要再 `disabled: true` 掉 `bash-sandbox`。重启 web 后刷新浏览器。

## Web 面板（右侧栏）

- 位置：dsh-sidebar「终端」tab，视觉对齐 pidance TerminalPanel。
- REPL：点击面板直接输入，Enter 执行，底栏 Ctrl-C 中断。
- chips：各终端、`+` 新建、关闭。

## 路由（POST JSON，/api 受 web-auth 保护）

| 路由 | 参数 | 说明 |
|---|---|---|
| `/api/dsh-web-terminal/snapshot` | sessionId | 全部终端列表 + 本会话关联标记 |
| `/api/dsh-web-terminal/read` | sessionId, id, count? | 读取滚动回显 |
| `/api/dsh-web-terminal/send` | sessionId, id, text | 发送命令 |
| `/api/dsh-web-terminal/signal` | sessionId, id, signal | SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP |
| `/api/dsh-web-terminal/kill` | sessionId, id | 关闭并移除终端 |
| `/api/dsh-web-terminal/spawn` | sessionId, name?, cwd? | 新建终端 |

## 已知取舍

- REPL 级（逐行发送 + 回显），不是 xterm 原始模式；vim/htop 这类全屏程序不适合。
- `terminal-host` 会话会出现在会话列表里（PTY owner），不要当编码会话用。
