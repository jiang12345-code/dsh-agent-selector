# dsh-agent-selector

**智能体选择器** — 像 DSH 的模型选择器一样，在对话输入框旁勾选委派目标与具体模型，把当前对话的任务派给外部智能体执行，结果流回对话。

> Works on DeepSeek Harness (dsh) `0.1.2-alpha.2` · MIT

## 它解决什么

你手上有多个 AI 工具的订阅与独占模型（Codex 的 ChatGPT 额度、WorkBuddy 的 hy3 活动价、自配的 MiniMax/Kimi/Qwen key……），散落在各自应用里。这个插件把它们收编进 DSH 一个入口：**勾选即委派，结果回对话，全程带出处凭证**。

## 通道全景

| 目标 | 通道 | 成本 | 延迟 |
|---|---|---|---|
| **Codex** | `codex exec --skip-git-repo-check --ephemeral -m <model>` | ChatGPT 额度 | 秒~分钟 |
| **WorkBuddy · 内置模型**（hy3 / Hy4 preview / GLM-5.3 系…动态聚合桌面端清单） | automation 桥：直写 WorkBuddy automations 表投递一次性任务，其本地调度器自动拾起，内置模型驱动完整 WorkBuddy agent 执行 | WorkBuddy 订阅（**hy3 等内置模型活动价**） | ≤30s 拾起 + 执行（分钟级） |
| **WorkBuddy · 自定义模型**（MiniMax / Kimi / Qwen / OpenRouter…实时读 models.json） | 直连通道：OpenAI 兼容端点 + 你自己的 key | 你的 API key | **秒级** |
| **Claude Code** | 原生 exe + 槽位 pin（兼容 2.1.x 目录硬校验），后端跟随你的 ANTHROPIC_BASE_URL | 该端点的计费 | 秒~分钟 |

内置模型清单**动态聚合**自 WorkBuddy 本地数据（sessions ∪ automations 的 model_id，对照桌面端显示名映射）——桌面端上下架模型，这里自动跟随，永不过时。

## 用法

- **对话输入框旁**：`🤖 目标 · 模型 ▾` 两步下拉——点智能体 → 点模型，勾选即存
- **设置 →「🤖 智能体选择器」**：状态灯 + hy3 桥探活 + 各通道测试按钮
- **对话里**：「用 hy3 把这份报告润色一下」/「派给 codex」/「用默认智能体查一下 X」→ 模型调 `agent_dispatch` 工具

## 反冒充保证

- **结构性**：工具无"DSH 自己作答"路径——一旦调用，返回只能来自外部进程
- **出处凭证**：每条结果带出处头（目标 · 模型 · 耗时 · 会话/对话 ID），只有真实执行才存在
- **条款约束**：工具声明要求"必须实调工具、禁冒充、失败如实报"
- **用户判据**：对话里有工具卡片 = 真委派；无卡片却称"codex 说" = 冒充

## 安装

```sh
git clone https://github.com/jiang12345-code/dsh-agent-selector
cd dsh-agent-selector
# 把包链接/复制进你的 profile（与其它 dsh 插件相同）：
#   Copy-Item -Recurse . "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-agent-selector\"
#   并在 profile package.json 的 dsh.profile.bundles 数组加入 "dsh-agent-selector"
# 重启 DSH（host 半生效）；页面硬刷新（client 半生效）
```

前置依赖见下方「前置依赖」；各通道可独立使用——没装 WorkBuddy 就只用 Codex/Claude 通道，互不影响。

## 机制与风险

hy3 桥经 2026-09-04 实验全链路验证（直写 automations 表投递 once 任务，`next_run_at` 为调度器唯一扫描键，实测 55s 全链路含中文；IO 全文件化规避 Windows 管道编码陷阱）。**属逆向依赖**：WorkBuddy 升级若改表结构/调度器实现，桥会碎——设置面板的测试按钮即探活，碎了亮红灯，不会静默出错。

## 前置依赖

- **Codex 通道**：本机装有 Codex CLI 并已登录（`npm i -g @openai/codex`）
- **Claude Code 通道**：Claude Code CLI + 已配置的第三方端点（本插件以槽位 pin 方式兼容 2.1.x 目录校验）
- **hy3 / wbmodel 通道**：本机装有 WorkBuddy 桌面端并已登录（hy3 走账户订阅=活动价；wbmodel 读 `~/.workbuddy/models.json` 的自定义模型，消耗你自己的 API key）
- Python 3.x（hy3 桥与 wbmodel 直连的执行引擎，标准库零依赖）

## License

MIT
