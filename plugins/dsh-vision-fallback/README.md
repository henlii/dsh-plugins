# dsh-vision-fallback

图片消息预分析 + 可主动调用的图片识别工具（vision_inspect）。

## 背景

dsh 的会话模型（`agent-default-model`）可能是不支持图片的文本模型（如
`deepseek-v4-flash`），官方适配器对含图请求直接报
`this model does not support image input`；且会话历史是 append-only，
图片一旦进入历史就会污染后续所有请求。

本插件提供三条能力：

1. **预分析（默认开）**：含图消息进入 inbox 时同步移除，先由视觉模型分析
   （带截断后的历史明文上下文），再把「原文本 + 图片标识/本地路径 + 分析
   结果」作为纯文本消息放回会话。图片字节从不进入会话历史与模型上下文；
   分析结果文本（含图片标识）进入上下文，主模型可直接使用。
2. **vision_inspect 工具**：主模型可主动调用的图片识别工具——输入图片标识
   （sha256:…）或本地路径，可附带指令与补充上下文；结果不理想可二次调用
   换指令再问（固定文令子智能体语义）。
3. **回退（预分析关闭时兜底）**：含图轮次临时切换到视觉模型，纯文本轮次
   自动切回主模型。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-plugins/plugins/dsh-vision-fallback
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

```yaml
- insert:
    - id: vision-fallback
      name: 'dsh-vision-fallback'
      config: {}
```

## 配置

在 Web 设置 → 插件配置 → **dsh-vision-fallback** 卡片：

1. 勾选「启用图片处理」；
2. 勾选「预分析模式」（推荐；关闭则退回每轮切换视觉模型模式）；
3. 选择供应商与视觉模型（catalog 只列声明支持 image 的模型）；
4. 保存。

配置写入 `settings.yaml` 的 `dsh-vision-fallback` 命名空间：

```yaml
dsh-vision-fallback:
  enabled: true
  preanalyze: true
  provider: cpa
  model: deepseek-v4-flash-vision-exp
  maxContextTokens: 8000   # 预分析/工具调用时历史明文上下文的截断上限
```

## 行为

### 预分析

- 含图消息在进入会话前被同步移除（`agent/inbox/inserted` 钩子）；
- 视觉模型调用携带：原图片块 + 原文本 + 截断后的历史明文上下文 + 任务指令；
- 完成后 followup 一条纯文本消息（原文本 / 图片标识与本地路径 / 分析结果）
  回 inbox，随本轮正常进入会话；
- 分析失败：原消息放回 inbox，不丢用户输入；
- 附件数据保留在存储层（不删除），`sha256:…` 标识与本地路径可随时取回。

### vision_inspect 工具

- 入参：`image`（sha256 标识或本地路径，必填）、`instructions`（可选指令）、
  `context`（可选补充上下文）；
- 按 sha256 先查会话历史，找不到则按本地对象路径读取后走附件服务重存
  （内容寻址去重，同一字节返回同一标识）；
- 带与预分析相同的上下文组装与截断；结果返回纯文本。

### 回退模式（preanalyze: false）

- `agent/request` 瀑布按「当前 turn」检测含图（不扫历史，避免污染）；
- 含图轮次切视觉模型；纯文本轮次恰为视觉模型时切回主模型；
- 视觉模型不可用时保持原模型，不中断请求。

## 已知取舍

- 预分析是异步的：用户消息后会有短暂等待（分析 90s 超时兜底）；
- 上下文截断按字符估算 token（3 字符/token 保守系数），非精确；
- 主会话历史与请求链不被修改（图片不出现在历史中，但附件不删除，
  可在本地 attachments/v1/objects 找回）。

## 冒烟测试

```sh
node plugins/dsh-vision-fallback/scripts/smoke.mjs
```

覆盖：纯函数（格式嗅探/图片检测/路径映射）、预分析时序（同步移除 → 分析 →
替换；失败放回原消息）、历史上下文截断（保留最近、超预算截断）、工具路径输入
全链路。已纳入集合根 `pnpm check`。
