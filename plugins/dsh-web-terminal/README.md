# dsh-web-terminal

把 agent 的**常驻交互终端**接到 Web UI：agent 执行 bash 命令时，你可以在网页上实时看到
命令与输出，并直接**发送新命令 / 中断 / 强杀 / 关闭**；你的每一次操作都会以「通知」形式
注入会话，agent 下一轮就能看到。

## 依赖

需要先启用**持久终端栈**（否则没有 PTY 可看可操作）：

```yaml
# 替换标准一次性 bash 为常驻 PTY shell
- id: tool-bash
  disabled: true

- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config: { timeoutMs: 300000 }
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      config: { timeoutMs: 300000 }
```

## 安装

```sh
dsh plugin --profile web add /root/works/open/dsh-plugins/plugins/dsh-web-terminal
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 insert 里追加：

```yaml
    - id: web-terminal
      name: 'dsh-web-terminal'
      config: {}
```

重启 dsh 生效：`systemctl restart dsh.service`。

## 使用

- 会话标题栏右侧出现「终端」按钮 → 点开显示终端面板（输入区上方）。
- 面板轮询（1s）显示 agent 的持久 shell 的实时输出。
- 底部输入框「发送」→ 命令写入 agent 的 shell 并回车执行；agent 会收到
  【Web 终端】通知。
- 「中断」= SIGINT，「强杀」= SIGKILL，「关闭」= 关闭会话。
- 若 agent 正在用该终端跑命令（一条发送在途），你的发送会返回 SEND_ACTIVE 冲突提示。

## 路由（POST JSON，/api 自动受 web-auth 密码保护）

| 路由 | 参数 | 说明 |
|---|---|---|
| `/api/dsh-web-terminal/snapshot` | sessionId | 会话的终端会话列表 + 是否活跃 |
| `/api/dsh-web-terminal/read` | sessionId, id, count? | 读取滚动回显 |
| `/api/dsh-web-terminal/send` | sessionId, id, text | 发送命令（自动确保 shell 存在） |
| `/api/dsh-web-terminal/signal` | sessionId, id, signal | SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP |
| `/api/dsh-web-terminal/kill` | sessionId, id | 关闭会话 |
| `/api/dsh-web-terminal/spawn` | sessionId | 启动 shell |

每次 send/signal/kill 都会 `agent.inject(createUserMessage(...))` 通知 agent。
