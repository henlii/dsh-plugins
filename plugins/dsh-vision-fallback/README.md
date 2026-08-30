# dsh-vision-fallback

主模型不支持图片输入时，自动回退到配置的视觉模型处理该轮请求。

## 背景

dsh 的会话模型（`agent-default-model`）可能是不支持图片的文本模型（如
`deepseek-v4-flash`）。用户发送带图片的消息时，官方适配器直接报
`this model does not support image input`，会话中断。

本插件在 `agent/request` waterfall（每次 LLM 请求的模型选择点）拦截：请求
消息含图片且当前模型不是配置的视觉模型时，把该轮请求切换到视觉模型。

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

1. 勾选「启用视觉回退」；
2. 选择供应商（内置 catalog 中声明支持 image 的模型，如 `deepseek-official`）；
3. 选择视觉模型（如 `deepseek-v4-flash-vision-exp`）；
4. 保存。

配置写入 `settings.yaml` 的 `dsh-vision-fallback` 命名空间：

```yaml
dsh-vision-fallback:
  enabled: true
  provider: cpa
  model: deepseek-v4-flash-vision-exp
```

## 行为

- 仅当请求消息（含 tool-result 嵌套）含图片时切换；
- 已是配置的视觉模型时不重复切换；
- 视觉模型不支持 `reasoningEffort` 时自动去掉该字段，避免 `prepareCall` 拒绝；
- 视觉模型不可用（解析失败）时保持原模型，不中断请求。

## 已知取舍

- 切换是**每轮请求**级的：含图片的轮次走视觉模型，纯文本轮次仍走主模型。
- 会话请求头会记录切换后的模型（`request/header` reason=change），便于审计。
