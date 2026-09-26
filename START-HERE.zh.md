# 从这里开始

[English](START-HERE.md) · **简体中文**

## 你复制的内容

一个可移植的 **DSH/Cordis 原生插件**与离线测试——而不是独立的 AI 运行时、已认证的账号或已就绪并通过资格验证的模型池。它适用于通用软件项目；目标环境需要一个兼容的 Host，并暴露原生 `tools`、`llm` 与 `subagents` API。

## 快速路径

1. 阅读 [README.zh.md](README.zh.md) 与[安全与限制](docs/SECURITY-AND-LIMITS.zh.md)。
2. 若要让另一个 AI 来安装它，请复制 [INSTALL-WITH-AI.zh.md](INSTALL-WITH-AI.zh.md) 中的完整提示词，并填入真实的可移植文件夹路径、项目路径与目标。
3. 确认 **Node.js >=22**、已安装的兼容 DSH Host，以及本文件夹中实际的 package 与脚本。
4. 在本文件夹中运行以下离线准备命令：

   ```sh
   node scripts/verify.mjs
   npm test
   node scripts/setup.mjs --tools-module "<actual-host-dsh-tools/lib/index.js>" --state-root "<absolute fresh state directory>"
   node scripts/doctor.mjs
   ```

   Verify 需要最终确定的 `portable-manifest.json`；它检测的是清单中所列文件的缺失／修改，而不是未列出的新增文件，并且它不是真实性签名。遇到不匹配或清单缺失时应停止，而不是臆造验证成功。

   `--state-root` 是可选的；指定它会隔离你的状态。请从 `--tools-module` 或另一种发现选项 `--harness-root "<absolute installed host directory>"` 中恰好提供一项，不要两者都提供。本包使用 Node 内置模块；无需 `npm install`。这些命令**不会**安装 DSH。
5. 检查 `.local/entry.mjs` 与 `.local/host-patch.yml`。Setup 只生成这两个文件。Doctor 是离线的；这两条命令都不能证明可以真实访问 provider。
6. 备份**当前由用户拥有的 Host 补丁**，并合并生成的根插入内容。不要整体覆盖该补丁、不要编辑随包提供的 preset，也不要盲目安装会冲突的 `orchestrator_*` 工具。遵循实际 Host 的重新加载流程。
7. 确认该 Host 暴露了十五个 orchestrator 工具。请通过受支持的 Host UI 为 provider 完成认证，绝不要把密钥放进对话中。
8. 在将要使用所选项目的**同一个根 agent 会话**中，发现真实路由，并运行少量精确的 `orchestrator_qualify` 探测。它们可能消耗配额或费用。先前机器上的成功不会迁移过来；证据在 24 小时后失效。
9. 先用一个只读的 `orchestrator_delegate` 任务开始，使用 [examples/task.json](examples/task.json) 以及 [examples/PROJECT-PROMPT.md](examples/PROJECT-PROMPT.md) 中限定范围的提示词。

## 「就绪」的含义

- 离线测试通过：仅限本地合成测试。
- 生成的文件通过 Doctor 检查：仅为本地候选安装。
- 工具在预期的运行中 Host 中可见：激活已验证。
- 精确的路由／effort 在本会话中通过了实时 echo 挑战：基本文本／工具资格已验证。
- 你限定范围的项目任务已完成，且其输出已被回读：实际使用已验证。

缺少兼容的 Host，或没有可用的已通过资格验证的路由，都是应当停下来并报告的理由——而不是臆造一次成功的安装。

## 重要默认值

**$1 是软性目标**，不是支出上限；常规的 Host 安全策略仍然适用。只读 agent 可以继续推进有边界的未完成工作；不确定或可能产生副作用的尝试不会被盲目重放。直接任务有 15 分钟的截止时间，从计划时刻开始计算。未知的订阅成本意味着**未知**，而不是零。图像／专业领域的工作需要基本冒烟测试之外的其他证据。在允许对项目进行写入之前，请先阅读 [USAGE.zh.md](docs/USAGE.zh.md)。
