# dsh-web-terminal (v2)

VS Code 式**全局独立终端**：终端与会话/工作区生命周期无关，不限制数量，会话↔终端
一对多，命令执行结束通知使用它的会话。Web 底部栏用 **tab 标签**切换多个终端。

## 模型

- **终端完全独立**：由稳定的 `terminal-host` 托管 agent 持有，数量不限，不随会话或
  工作区消亡；重启 dsh 后陈旧终端自动重建。
- **会话↔终端一对多**：会话的 `bash` 命令默认走会话的主终端（首次自动创建并关联）；
  会话可用 `terminal_new` / `terminal_send` 主动调用任意多个终端。
- **执行结束通知会话**：每次命令结束，向使用该终端的所有会话注入
  `【终端】命令执行结束（exit N）…` 通知。
- **所有预设都生效**：本插件**替换 `ctx.shell`**（禁 `dsh-bash-sandbox`），而所有
  预设共用的标准 `dsh-tool-bash` 是 `ctx.shell` 的消费者——不用改任何预设。

## 组合

```yaml
- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config: { timeoutMs: 300000 }
    - id: web-terminal
      name: 'dsh-web-terminal'
      config: {}

# 停用默认一次性 shell，由 dsh-web-terminal 提供持久 PTY 版 ctx.shell
- id: bash-sandbox
  disabled: true
```

## 安装

```sh
dsh plugin --profile web add /root/works/open/dsh-plugins/plugins/dsh-web-terminal
```

重启生效：`systemctl restart dsh.service`；Web 面板代码变更后**刷新浏览器**加载新
客户端。

## 模型工具

| 工具 | 作用 |
|---|---|
| `terminal_new` | 新建独立终端（可指定 name/cwd），返回 terminal_id |
| `terminal_send` | 在指定终端执行命令（等待结果，支持后台 job） |
| `terminal_list` | 列出所有终端（id/名称/状态/使用它的会话） |
| `terminal_kill` | 关闭终端并移除 |

## Web 面板

- 会话标题栏「终端」按钮 → 底部栏（输入区上方）展开终端面板。
- **tab 标签**：显示全部终端，点击切换；`+` 新建；`×` 关闭；本会话的终端带 ★。
- 每终端：1s 轮询实时输出、输入框发送（Enter）、中断（SIGINT）/ 强杀（SIGKILL）。
- 你的每次发送/中断/关闭都会通知使用该终端的会话。

## 路由（POST JSON，/api 自动受 web-auth 密码保护）

| 路由 | 参数 | 说明 |
|---|---|---|
| `/api/dsh-web-terminal/snapshot` | sessionId | 全部终端列表 + 本会话关联标记 |
| `/api/dsh-web-terminal/read` | sessionId, id, count? | 读取滚动回显 |
| `/api/dsh-web-terminal/send` | sessionId, id, text | 发送命令 |
| `/api/dsh-web-terminal/signal` | sessionId, id, signal | SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP |
| `/api/dsh-web-terminal/kill` | sessionId, id | 关闭并移除终端 |
| `/api/dsh-web-terminal/spawn` | sessionId, name?, cwd? | 新建终端 |

## 已知取舍

- 退出码通过行尾 `__DSH_RC__` 标记解析（与原生 bash -c 的「末条命令退出码」语义一致）。
- 交互类程序（vim 等）经 bash 工具调用会按超时处理；可在 Web 面板里直接交互。
- 后台 job（`run_in_background`）走一次性子进程（不需要终端持久性）。
- 终端按工作目录命名（VS Code 每文件夹一终端）；同一目录的多个会话共享该终端，
  但各自记录使用关系。
