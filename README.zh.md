# Multi-agent：可移植的 DSH/Cordis 编排插件

[English](README.md) · **简体中文**

> **中文读者**：完整中文文档见 [README.zh.md](README.zh.md)，其中包括[使用指南](docs/USAGE.zh.md)与[安全与限制](docs/SECURITY-AND-LIMITS.zh.md)。本插件为 DeepSeek Harness (DSH)/Cordis 宿主提供路由选择、有界子 agent 委派、并行只读批处理与结构化评审记录；它依据本会话的实时资格证据工作，**不会自动节省 token**，也不保证裁定正确。

[![CI](https://github.com/WDahah/portable-dsh-multi-agent-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/WDahah/portable-dsh-multi-agent-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/WDahah/portable-dsh-multi-agent-plugin)](https://github.com/WDahah/portable-dsh-multi-agent-plugin/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](package.json)

**路由任务、运行有作用域的 agent、收集并行发现，并记录结构化评审——同时具备明确的边界与持久的历史。**

增加第二个 agent 很容易。难的是知道哪个 agent 做了什么、用了哪个工具、依据哪条策略，以及它何时必须停止。Multi-agent 以十五个原生工具的形式，为你的 DSH 宿主提供这层协调能力，且无需安装任何依赖。v1.14 还新增了一个需显式启用的**治理门禁**：从计划到经评审候选方案的六阶段、由人授权的路径。

- **唯一可问责的监督者。** worker 只得到有作用域的提示词与工具允许清单，并且不能再向下委派。
- **先证据后调度。** 只有在你自己的会话中完成一次全新的实时资格验证之后，路由才会被使用。
- **明确的停止点。** 轮次上限、评审循环上限、截止时间与作者尝试预算都事先固定。
- **可追溯的记录。** 每次委派任务都保留其路由、模型、提示词、输出与失败状态。

这是一个面向兼容 **DeepSeek Harness (DSH)/Cordis 宿主**的原生插件，不是独立框架，也不是托管服务。它依据会话范围内新鲜的冒烟证据选择路由、运行有界工作，并记录提示词、结果、模型身份与失败状态。评审者声明工作是否通过；插件遵从该声明，而不自行判断答案是否正确。

**Multi-agent 不会自动节省 token。** 在[27 次试验的基准测试](docs/BENCHMARK.md)中，并行 worker 加上整合环节比单个 agent 多消耗 **92.2% 的 token**。它们比同样的 worker 串行运行**快 23.5%**，但比单个 agent 慢。使用委派是为了有效分离工作，而不是假定能省 token。

## 目录

- [为什么需要控制平面](#why-a-control-plane)
- [功能特性](#features)
- [新增：治理门禁](#new-governance-gate)
- [强制条件](#mandatory-conditions)
- [它能节省 token 吗？](#does-it-save-tokens)
- [无需宿主即可试用](#try-it-without-a-host)
- [运行要求与安装](#requirements-and-installation)
- [第一批任务](#first-tasks)
- [十五个工具](#the-fifteen-tools)
- [路由与资格验证](#routing-and-qualification)
- [限制与安全](#limits-and-safety)
- [验证与开发](#validation-and-development)
- [文档](#documentation)

## 为什么需要控制平面 <a id="why-a-control-plane"></a>

Rod Trent 的[*Multi-Agent Systems and Orchestration: The Hard Problem Is Coordination*](https://rodtrent.substack.com/p/multi-agent-systems-and-orchestration)一文认为，编排是架构问题，而不是提示词问题。它列出了协调层必须刻意规定的七件事。本插件对每一条的回答是：

| 要求 | Multi-agent 如何应对 |
|---|---|
| **端点与契约** | 每次调用都携带一个类型化的 `task` 对象、一个明确的提示词和一份工具允许清单。拒绝会返回具名理由，例如 `MISSING_EXACT_QUALIFICATION`。 |
| **拓扑** | 星形：父 agent 负责监督，子 agent 的委派深度为一。没有对等网状结构，因此每个决策都能通过父 agent 回溯。 |
| **权限** | 评审者*声明*裁定；插件记录这些声明，不评判工作本身。在治理门禁中，只有人能授权计划，模型输出不能。 |
| **状态** | 按所有者持久化的日志，记录委派任务、批次、资格验证与直连任务，无需调用模型即可读取。聊天记录不是事实来源。 |
| **聚合** | 显式而非隐藏：批次按请求顺序返回发现，由你自己增加整合步骤并计入其成本。 |
| **终止** | `max_rounds`、最多三轮评审／修订循环、每次调用的截止时间、资格验证 24 小时过期，以及治理门禁中的三次作者尝试。 |
| **失败策略** | 不确定的工作绝不会被自动重放。故障转移 需显式启用，且仅适用于调度前的拒绝。`needs-clarification` 与相互矛盾的裁定会停止循环并交回给你。 |

文章中的实务建议也已内建：让 worker 保持狭窄、优先采用确定性脚手架（门禁中固定的阶段顺序）、记录每一次交接，并在需要判断的节点保留人工介入。

## 功能特性 <a id="features"></a>

| 功能 | 作用 | 重要限制 |
|---|---|---|
| **基于任务的路由** | 依据 role、风险、复杂度、数据类别与所请求的能力选择已通过资格验证的路由；并报告选择依据 | 确定性策略，不是质量预测器，也不是最低价优化器 |
| **实时资格验证** | 针对一个确切的 provider/model/effort 探测文本与原生工具往返；可选图像／结构化输出探测与操作者声明 | 有界的冒烟测试并不能证明它胜任你的任务 |
| **有作用域的委派** | 以明确的提示词与工具允许清单运行一个原生子 agent；按轮次记录其模型与输出 | 提示词中的范围不等于路径级沙箱强制 |
| **只读并行批次** | 接受 2–8 个独立任务，最多运行两个 worker，并按请求顺序收集有界发现 | 范围由调用方提供；没有自动分解、依赖图、综合或语义验证 |
| **provider 多样化评审** | 优先选择来自另一 provider 的评审者，并记录该偏好是否被满足，包括 故障转移 之后 | provider 不同并不证明推理独立或裁定正确 |
| **有界的评审／修订循环** | 依据结构化裁定最多进行三轮；在需要澄清、前后矛盾、输出无法解析或达到上限时停止 | `VERIFIED` 是评审者的声明，不是独立测试结果 |
| **持久记录** | 存储委派任务、批次、资格验证与直连任务的状态；无需模型调度即可读取／列出／删除 | 本地明文状态；单进程协调，不是分布式锁 |
| **保守的续跑** | 对符合条件的只读工作，可从中断于干净 token 上限处继续；不会自动重跑具备写能力的工作 | 续跑会再创建一个子 agent 并消耗更多 token；不确定的工作不会被重放 |
| **需显式启用的分散与 故障转移** | 确定性地轮换符合条件的路由；对只读工作，在识别到调度前拒绝后可尝试备用路由 | 不是实时负载均衡、provider 配额调度或通用错误重试 |
| **分离的计量信号** | 直连任务暴露可获得的每轮用量与缺失用量计数；原生委派任务暴露承诺、返回的子 agent 与耗时 | 原生子 agent 结果不会向本插件暴露累计 token 用量 |

### v1.14.0 中的并行批次

批次 worker 与普通委派和压缩共享**两个原生执行槽位**。剩余的批次工作可在内部 FIFO 队列中等待，该队列最多容纳**八个待处理保留位**。普通的 delegate/compact 调用在繁忙时会拒绝；每个所有者最多只有一个活动批次。

worker 只使用 `read`、`glob` 和 `grep`，各自执行一轮委派。它们返回一段简短摘要、最多五条带证据的发现，以及至多三项不确定之处。一轮委派可能包含若干模型／工具步骤。批次 worker 没有自动续跑、故障转移 或压缩。**批次不包含整合调用**；如果你需要合并后的答案，请自行显式添加并计入其成本。

槽位会一直保持占用，直到子 agent 结果与资源释放都稳定下来，即使已经取消也是如此。已保存的批次 ID 无法重放；未完成而恢复出来的批次会报告 `INTERRUPTED_UNKNOWN`。[完整的批次行为与限制 →](docs/USAGE.zh.md#parallel-read-only-batches)

原生 `orchestrator_delegate` 与 `orchestrator_iterate` 调用现在最长可运行 **2,500,000 ms（约 42 分钟）**，高于此前的 15 分钟，以便更长的评审能够完成。这是上限而非典型时长：一次简短的委派通常几秒内返回。

## 新增：治理门禁 <a id="new-governance-gate"></a>

治理门禁是一条独立的、**需显式启用**的入口，适用于每一步都需要人签字确认的工作。它把一个已配置的任务变成固定的六阶段序列，且每个阶段都必须由人发起请求：

```text
open → plan-review → human authorization → author → seal → validate → review
```

- **在聊天框中输入的人工命令。** 在专用宿主中，操作者把 `/gov-status`、`/gov-open`、`/gov-stage`、`/gov-authorize` 及其他命令直接输入 DSH Web GUI。输入框会为每个命令显示一条参数提示。模型输出、复制的文本或嵌套的模型调用都不能授权任何事。
- **独立检查。** 计划在任何作者运行之前先经评审。作者的候选方案被逐字节封装，然后用固定版本的受信测试验证，并单独评审。
- **硬性尝试预算。** 总共三次作者尝试：首次加两次修正。任何情况都不退还尝试次数，包括暂停、重启或新建工作区。
- **同一所有者的暂停与恢复。** `/gov-pause` 返回一次性检查点；`/gov-resume <checkpoint> author` 恰好消费它一次。
- **有界的只读诊断。** `/gov-read` 分页显示状态、历史、证据与产物，每次回复不超过 16 KiB。它不是文件读取器。
- **资格验证与离线验收。** 在一次性资格验证宿主中，`/gov-accept`、`/gov-qualify` 与 `/gov-export` 会生成回执。每份回执都带有 `qualificationOnly:true`、`operationallyAccepted:false` 与 `gateActive:false`。

### 示例：一个任务从计划到导出

以下是在接收者会话中手动输入的完整演练。每一行都作为单独消息发送，此处的摘要值已缩短。请从上一步的回复中复制真实值；每条回复都会指明下一步允许执行的操作。

| 你输入的内容 | 会发生什么 | 回复中的关键字段 |
|---|---|---|
| `/gov-status` | 在任何步骤开始前读取任务 | `gateActive:false` |
| `/gov-open <projectId> <planDigest>` | 打开那一个已配置的项目与计划 | `headAuthenticity:"live-verified"` |
| `/gov-stage plan-review` | 一位独立评审者检查计划 | `phase:"AWAITING_HUMAN"`, `resultId` |
| `/gov-authorize <planDigest> <resultId> authorize` | 你批准这一确切的计划 | plan-review 结果变为一项人类决策 |
| `/gov-stage author` | 作者撰写候选方案（用掉 3 次尝试中的 1 次） | `phase:"AUTHORING"` |
| `/gov-stage seal` | 候选方案的确切字节被冻结 | `candidateDigest:"1422…"` |
| `/gov-stage validate` | 对已封装的字节运行固定版本的受信测试 | `outcome:"completed-pass"` |
| `/gov-stage review` | 另一位评审者评判该候选方案 | `phase:"DIAGNOSTIC_READY"` |
| `/gov-accept <candidateDigest> <headDigest>` | 记录一次离线验收，不激活任何东西 | `acceptanceRecorded:true` |
| `/gov-qualify <candidateDigest> <newHeadDigest>` | 重新检查全部内容并出具回执 | `qualificationReceiptDigest:"4cce…"` |
| `/gov-export <receiptDigest> <destinationId>` | 把候选方案复制一次到固定目标位置 | `deliveryPhase:"completed"` |
| `/gov-export …`（再次输入同一行） | 该重放请求被拒绝 | `reason:"DELIVERY_NOT_AUTHORIZED"` |
| `/gov-stop` | 撤销准入并关闭该所有者 | — |

accept 与 qualify 各自都会追加一个事件，因此在下一步之前请用 `/gov-status` 读取当前的 `headDigest`。每个步骤都可能以具名 `reason` 拒绝，任何步骤都不会自行推进。随后导出文件夹中恰好包含 `payload/`、`descriptor.json`、`qualification-receipt.json` 与 `complete.json`。你正在其中工作的仓库绝不会被修改。

两种常见错误：
- **在新会话中发送命令。** 请在接收者会话中输入命令，而不是在 **New Session** 中。在其他任何地方，它们都会以 `M4_HUMAN_RECEIVER` 被拒绝。
- **一条消息里放多个命令。** 每条消息只发送一个命令；多个命令粘贴在一起会被当作单条聊天消息。

它**不是**什么：它不会在你的日常宿主中自行激活，不会把候选方案应用到你的检出目录，也无法在冷重启后存活。进程丢失后，存储变为只读并标记为 `RECONCILIATION_REQUIRED`。在原生 Web GUI 中手动输入的演练已在一次性资格验证宿主中执行过；那是资格验证证据，不是运行验收。

[完整的治理指南：配置、命令、诊断、暂停／恢复与限制 →](docs/GOVERNANCE.md)

## 强制条件 <a id="mandatory-conditions"></a>

每一次委派给 agent 的变更都按顺序遵循这六个阶段。任何阶段都不得跳过，作者也绝不批准自己的工作。

| 阶段 | 必需产出 |
|---|---|
| **1. 评估** | 确定实际故障、受影响的路径、现有行为与证据。把已确认的缺陷与未知项区分开。 |
| **2. 计划** | 确切说明哪些文件与行为必须变更、修复将如何生效、哪些必须保持不变、风险、测试、验收标准与恢复步骤。 |
| **3. 评审计划** | 独立评审者检查正确性、范围、安全性，以及所提议的测试能否确立预期结果。在实施前解决阻断性发现。 |
| **4. 实施** | 只在指定的文件范围内委派已评审过的变更。不做顺手修复，也不扩大该委派任务。 |
| **5. 验证与评审** | 独立验证者执行必需的测试；另一位评审者检查确切的结果变更。作者不能批准自己的工作。 |
| **6. 验收或停止** | 只验收确切的、已验证的候选方案。针对同一验收标准最多允许两轮修正；否则停止实施并重新评估。绝不要为了通过而弱化测试。 |

### 治理门禁如何强制执行这些条件

[治理门禁](#new-governance-gate)把阶段 2–6 变成受检查的步骤。阶段 1 仍由你负责：门禁从计划开始，无法判断你的评估是否正确。

| 阶段 | 门禁检查什么 | 出问题时如何拒绝 |
|---|---|---|
| 2. 计划 | 计划必须列出待变更文件及其预期哈希、非目标、受保护测试、验收标准与确切的测试命令。未知或缺失字段会被拒绝。 | plan validation error |
| 3. 评审计划 | `/gov-stage plan-review` 运行一位不是计划制定者、且使用不同 provider 的评审者。在你用 `/gov-authorize` 批准之前不会写入任何内容。 | `INDEPENDENCE_REQUIRED` |
| 4. 实施 | 作者只在一次性副本中工作，受保护测试文件不能出现在它变更的文件中。验收会复查计划之外没有任何变更，导出会拒绝准入集合之外的任何文件。 | `PROTECTED_PATH`, `DELIVERY_EXTRA_FILE` |
| 5. 验证与评审 | 候选方案的字节先被封装。验证者在这些已封装的字节上运行按哈希固定的测试，另一位评审者对其进行评判。二者都不能是计划制定者或作者，验证者与评审者必须是不同的 agent，且评审者必须使用与作者不同的 provider。 | `INDEPENDENCE_REQUIRED` |
| 6. 验收或停止 | `/gov-accept` 与 `/gov-qualify` 绑定到一个候选方案摘要。修正上限固定为 2（共 3 次作者尝试）；此后任务转入 `REASSESS_REQUIRED`。测试文件按哈希固定，因此无法被弱化。 | `INVALID_BUDGET`, `REASSESS_REQUIRED` |

即使不使用门禁，这六个阶段仍然是使用编排工具时的规则：先做计划，然后用 `review` role 的 `orchestrator_delegate` 评审计划，接着执行一次有作用域的实施委派，最后分别进行验证委派与评审委派。

### 运行要求

安装前请先核对这些条件。若有任何一条不满足，工具要么不会出现，要么会拒绝工作。

**面向编排器（所有用户）：**

1. **Node.js 22 或更新版本**以及 **Git**。
2. **一个正在运行的兼容 DSH/Cordis 宿主**，提供原生工具、LLM 流式输出与子 agent。本插件无法独立运行。
3. **宿主自身的 `dsh-tools/lib/index.js`**，以绝对路径传给 setup。不要从其他安装中复制该模块。
4. **已在宿主中完成认证的 provider 账号。** 本插件不附带任何凭据。
5. **显式启用并重启宿主。** 插件默认禁用。把生成的补丁加入你的*用户自有* profile，设置 `enabled: true`，然后重启 DSH。绝不要编辑随包发布的 preset。
6. **在将要调度工作的同一个根会话中完成资格验证。** 资格验证在 24 小时后过期，且不会在会话或机器之间转移。

**面向治理门禁（额外要求）：**

1. **Windows x64 与 Node 26.9.0。** 这是唯一受门禁保护的执行通道。
2. **一个专用的、一次性的宿主。** 绝不要用你的日常 profile。setup 会生成一个不生效的候选配置，且绝不替你挂载它。
3. **一份经评审的配置**，带确切的固定值：bundle 与安装哈希、Node/Git/宿主文件、各阶段路由、固定的接收者 ID，以及六个互不相同的规范化根目录。
4. **受限的会话策略。** `danger-full-access`、缺失的服务或变更过的固定值都会阻止阶段准入。
5. **有人在键盘前。** 命令必须来自已注册的接收者会话。请在侧边栏点击打开该会话，而不是 **New Session**。没有任何轮次的崭新会话会显示 Web 落地页，而不是命令回复。

## 它能节省 token 吗？ <a id="does-it-save-tokens"></a>

**在下面测得的负载中并不能。** 把文件内容留在子 agent 会话中确实可以减小主对话的上下文，但这些子 agent 仍然消耗 token。重复的指令、独立的上下文、评审与整合，可能比一个 agent 独自完成更贵。

该基准测试使用三个有界的仓库检查负载、三次重复，并对所有方式都使用同一个 Codex `gpt-5.6-luna` 模型、中等 effort。两种多 agent 方式都包含一次最终的整合调用。

| 方式 | 通过数 | 每次试验平均 token | 每个通过结果的平均 token¹ | 平均耗时 |
|---|---:|---:|---:|---:|
| 单个 agent | 6/9 | **17,729** | **26,594** | **18.0 s** |
| 串行 worker + 整合 | 9/9 | 34,404 | 34,404 | 38.2 s |
| 并行 worker + 整合 | 8/9 | 34,076 | 38,335 | 29.2 s |

¹ 消耗的全部 token（含失败的回答）除以通过的结果数。这不是对重试成本的估计。

- 通过随包发布插件计量接口之外的临时宿主遥测，捕获了 **63 个原生子 agent 会话**中 **108/108 次观测到的模型调用**的用量。
- 并行的每个通过结果所用 token 比单 agent 执行**多 44.2%**，而相对串行 worker 的总 token 差异**仅为 1.0%**。
- 三个单 agent 回答漏掉了一半问题。一个并行回答在事实上正确，但返回了五条发现，而要求是四条。所有成本都仍计入。
- 配置、资格验证、试运行、外层对话与外部验收评分均未计入。这些是有界的任务执行总量，**不是整个实验的 token 账单**。美元成本未知。
- 评分并非盲评，缓存／provider 负载不受控，且每个负载只有三次重复。该基准测试使用的是评审修复前的 v1.14.0 工作快照，不是新旧版本的 A/B 测试；它没有在最终修复上重跑。

**建议：** 小规模检查默认使用一个 agent。当独立范围、或相对于串行专精 agent 的延迟收益足以抵偿开销时，再选择并行专精 agent。这些测量既不能支撑普遍的省 token 结论，也无法预测更大的任务。

[方法、总计与限制](docs/BENCHMARK.md) · [全部 27 次试验测量（CSV）](docs/benchmarks/native-readonly-trials.csv)

## 无需宿主即可试用 <a id="try-it-without-a-host"></a>

在已安装 Node.js 22 或更新版本与 Git 的前提下：

```sh
git clone https://github.com/WDahah/portable-dsh-multi-agent-plugin
cd portable-dsh-multi-agent-plugin
node demo.mjs
```

该演示用**合成的资格验证证据**运行项目真实的路由与裁定解析逻辑。它不发起任何 provider 调用，也不证明任何路由可用或任何答案正确。它演示了选择、拒绝、过期、provider 多样性偏好与已声明裁定的处理。

你可以只运行单个场景：`node demo.mjs routing`。其他场景有 `refusal`、`expiry`、`diversity`、`verdicts`、`objective` 与 `aliases`。

## 运行要求与安装 <a id="requirements-and-installation"></a>

实际运行时你需要：

- Node.js **22+** 以及一个正在运行的兼容 DSH/Cordis 宿主。
- 用于原生工具、LLM 准备／流式输出与子 agent 的宿主 API。
- 目标宿主实际的 `dsh-tools/lib/index.js` 模块。
- 通过宿主支持机制完成认证的 provider 适配器与账号。

本包只使用 Node 内置模块，没有任何包依赖；**此处不需要 `npm install`**。但这并不免除对宿主的要求。该整合是针对 `dsh-tools` **0.1.5-rc.2** 与 Cordis **^4.0.2** 开发的，并非适用于所有宿主版本。

**两种安装方式。** 如果你的宿主用 `dsh plugin` 安装插件，直接添加本包，然后跳过本节其余步骤：

```sh
dsh plugin --profile <name> add git+https://github.com/WDahah/portable-dsh-multi-agent-plugin.git
```

本包声明了 `dsh.bundle` 补丁，因此 profile 会自行挂载它，状态目录默认为 `$DSH_HOME/portable-multi-agent-state`；在 profile 补丁里设置 `stateRoot` 可覆盖该默认值。下面的复制并合并步骤仍然是手工安装插件的宿主、以及把本包放在宿主目录之外时的做法。

1. 按 [START-HERE.md](START-HERE.zh.md) 操作，或使用 [INSTALL-WITH-AI.md](INSTALL-WITH-AI.zh.md) 中有作用域的提示词。
2. 校验随附的清单并运行离线测试。
3. 使用你实际的宿主模块路径生成并检查本地入口与候选宿主补丁。
4. 备份并使用其受支持的重新加载流程更新**当前生效的用户自有宿主组合**。绝不要编辑随包发布的 preset，也不要静默添加会冲突的 `orchestrator_*` 注册。
5. 确认十五个工具都可见，然后在将要调度工作的**同一个根会话**中资格验证所需的路由。

核心命令（在包根目录下）：

```sh
node scripts/manifest.mjs --check
node scripts/setup.mjs --harness-root <absolute installed DSH directory> --state-root <absolute state directory>
node scripts/doctor.mjs
```

然后把 `.local/host-patch.yml` 中的 `insert` 条目复制到你 profile 的 `cordis.patch.yml`，设置 `enabled: true`，并重启 DSH。

setup 会生成 `.local/entry.mjs` 与 `.local/host-patch.yml`；它不会安装 DSH、激活插件或认证账号。doctor 离线检查本地整合。在被宿主配置刻意启用之前，插件默认处于禁用状态。

完整性清单能发现所列文件的缺失或变更；它**不是真实性签名**，验证器也不会拒绝未列出的额外文件。哈希不匹配可能意味着文件被改动、损坏或行尾符被转换。请调查它；不要为了掩盖意外的哈希不匹配而重新生成清单，也不要对有价值的本地工作执行破坏性重置。

## 第一批任务 <a id="first-tasks"></a>

### 委派一次只读检查

在激活并完成资格验证之后，用类似下面的参数调用 `orchestrator_delegate`：

```json
{
  "task": {
    "role": "standard",
    "intent": "explain the auth flow",
    "category": "code-inspection",
    "risk": "low",
    "complexity": "routine",
    "escalate": false,
    "dataClass": "internal"
  },
  "run_id": "auth-inspect-001",
  "prompt": "Inspect src/auth only. Explain the authentication flow with file:line evidence. Do not edit files, run commands, or access the network.",
  "allowed_tools": ["read", "glob", "grep"],
  "max_rounds": 1,
  "max_tokens": 16384
}
```

这些是**宿主工具参数**，不是 shell 命令。请把路径替换为你项目中的真实范围。用 `orchestrator_delegate_read({"run_id":"auth-inspect-001"})` 读取已保存的输出。被显式授权的实施任务可以增加 `write`/`edit`；它们在触及 token 上限后不会获得自动的新子 agent 续跑。

### 检查两个相互独立的范围

用一份共享 brief 与各自独立界定范围的任务调用 `orchestrator_batch`：

```json
{
  "batch_id": "inspect-001",
  "brief": "Read-only inspection. Report bounded findings with file:line evidence, not edits.",
  "tasks": [
    {
      "id": "dispatch",
      "scope": "src/agent-dispatch.mjs",
      "prompt": "Inspect admission and cancellation behavior only.",
      "task": {"role":"standard","category":"code-inspection","risk":"low","complexity":"routine","escalate":false}
    },
    {
      "id": "routing",
      "scope": "src/routes.mjs",
      "prompt": "Inspect route selection and evidence checks only.",
      "task": {"role":"standard","category":"code-inspection","risk":"low","complexity":"routine","escalate":false}
    }
  ]
}
```

`orchestrator_batch_read({"batch_id":"inspect-001"})` 返回摘要；加上 `"details":true` 可获取发现。`COMPLETED` 意味着 worker 已结束并声明完成——并不意味着其发现已被验证。[参数限制与恢复 →](docs/USAGE.zh.md#parallel-read-only-batches)

## 十五个工具 <a id="the-fifteen-tools"></a>

| 工具 | 用途 |
|---|---|
| `orchestrator_inventory` | 已配置的路由与已记录的证据；不调用 provider |
| `orchestrator_qualify` | 精确的 route/effort 冒烟测试、可选能力探测与操作者声明 |
| `orchestrator_qualification_echo` | 内部的活动挑战辅助工具 |
| `orchestrator_capacity` | 已记录的路由可用性与建议的重新资格验证；不是实时 provider 容量 |
| `orchestrator_delegate` | 选择一条通过资格验证的路由并运行一个有作用域的原生子 agent |
| `orchestrator_delegate_read` | 读取已保存的委派任务输出，而不进行调度 |
| `orchestrator_batch` | 用两个 worker 从 2–8 个只读任务收集有界发现 |
| `orchestrator_batch_read` | 读取已保存的批次摘要或详细发现 |
| `orchestrator_iterate` | 由已声明裁定驱动的有界评审／修订循环 |
| `orchestrator_plan` | 选择并持久化一个直连模型任务 |
| `orchestrator_run` | 在符合条件的续跑范围内执行已计划的直连任务 |
| `orchestrator_read` | 读取直连任务输出与可获得的计量 |
| `orchestrator_resume` | 只恢复引擎批准的安全状态，绝不恢复不确定的工作 |
| `orchestrator_list` | 列出委派任务、批次、直连任务或资格验证证据 |
| `orchestrator_forget` | 永久删除符合条件的已保存记录；适用在途／引用检查 |

[完整工具参考 →](docs/USAGE.zh.md)

## 路由与资格验证 <a id="routing-and-qualification"></a>

role 取值为 `standard`、`deep`、`review`、`vision` 与 `domain`。自由文本 `intent` 描述任务，但不改变路由。普通工作默认为 **balanced**。高级 role 或关键风险本身即可作为 **advanced** 的理由；否则升级需要佐证依据。`escalate:true` 请求 **long-horizon**。显式的 `pool` 会覆盖默认策略；**economy 不会被自动选中**，仅仅因为任务看起来简单也不行。

[随包提供的路由](src/routes.mjs)是特定部署环境下的候选，并非普遍可用的承诺：

| 池 | 候选优先级 |
|---|---|
| economy | Luna, DeepSeek V4 Flash, K2.6, Sonnet |
| balanced | Terra, Sonnet, DeepSeek V4.1 Flash label |
| advanced | Sol, Opus, K3 |
| long-horizon | Fable, Astra, K3 |

模型标签／标识符是源码中配置的那些，不是固定版本的模型。你的宿主必须暴露确切的 provider/model/effort 并通过全新的资格验证。在其他宿主上，路由映射可能需要一次经评审的改动。本包不附带任何凭据或可转移的资格验证结果。

有两个宿主事实决定一条路由究竟能否工作，而插件自身的测试两者都看不到：

- **Provider id 命名的是具体接口面。** `kimi-coding` 是 Kimi Code 订阅端点（`api.kimi.com/coding`，Anthropic 协议，模型 `k3` 与 `kimi-for-coding`）；`moonshotai` 是 Moonshot 开放平台（`api.moonshot.ai/v1`，OpenAI 兼容，模型 `kimi-k3`、`kimi-k2.6`、`kimi-k2.7-code`）。为其中一个签发的密钥会被另一个拒绝，因此这两个 id 不是同一服务的不同拼写。
- **已安装适配器目录未描述的模型 id 会以纯文本路由提供。** 宿主仍会转发该 id，但不带图像模态：每个图像块在调度前都会被替换为确定性占位符，因此该路由上的图像探测永远无法通过。专用的 `vision` 池正因此被废弃——承载它的 `dsh-llm-deepseek` 0.1.7-rc.2 目录不再包含 `deepseek-v4-flash-vision-exp`，而 0.1.5-rc.2 的兼容性参考中是有的。在资格验证之前，请读取 `ctx.llm.listModels(<provider>)`，或 provider 自己的模型列表。

资格验证按所有者／根会话界定，并在 **24 小时**后过期。文本／工具探测确立基本可达性；图像与结构化输出探测覆盖那些具体能力。领域胜任力与更宽的数据类别许可需要具名的操作者声明。声明记录的是一项决定——它不证明专业能力，也不证明 provider 如何处理数据。

优先顺序是默认行为。`spread:true` 是确定性轮换，不是实时负载均衡，也不保证均等分配；评审者 provider 偏好优先。`failover:true` 需显式启用，且仅限只读委派任务中不带输出的、已识别的调度前拒绝。先前的资格验证绝不保证后续调用一定成功。

## 限制与安全 <a id="limits-and-safety"></a>

- **不自动保证正确性。** 结构化输出校验的是字段，不是真伪。评审者声明 `verified`、`partial`、`failed` 或 `needs-clarification`。相互矛盾的裁定会停止循环；它们不会被静默化解。
- **不保证节省 token，也没有硬性支出上限。** 在有价格数据时，直连任务会报告 1 美元的软性估算目标；原生／订阅方式的货币成本可能未知。所请求的 token 上限与截止时间不是财务上限。
- **插件中没有完整的原生用量台账。** 原生委派任务／批次把用量报告为未知；子调用承诺数与返回的子调用数不是模型调用次数。直连任务会暴露可获得的用量与缺失轮次。已发布的基准测试使用的是另外的临时遥测。
- **宿主策略依然适用。** 工具允许清单限制暴露的工具，但提示词中的范围不是独立的文件系统安全边界。本插件不会绕过沙箱或审批控制。
- **不自动重放不确定的工作。** 在干净的 token 上限之后，只读续跑是有界的；具备写能力的部分工作需要对账。已保存的文本仍可能不完整或格式不正确。
- **规模小、所有者本地的并发。** 每个所有者最多同时运行两次资格验证和两个原生 delegate/compact 委派任务。批次 worker 共享原生槽位，并可能在内部排队；普通的繁忙调用会被拒绝。直连模型任务与资格验证不共享原生准入池。这不是 provider 级的配额控制器。
- **没有对等 agent 协议或共享写协调。** 子 agent 的委派深度为一；插件通过父 agent 传递已记录的结果。批次是只读的，无法证明调用方提供的范围彼此独立。
- **本地持久化有局限。** 日志只在单个进程内协调，不跨多个进程或机器。批次日志失败会中止同级任务；孤立的单个委派任务日志失败会让该任务保持未完成，而其他任务可能继续。在开展替代工作之前，请先检查不确定的记录。
- **明文保留。** 提示词与可见输出会一直留在状态目录中，直到被删除。请保持其私有，并在其他安装中使用全新的状态目录。删除是永久性的；它不会撤销外部的副作用。
- **订阅桥接可能导致每一次工具往返都失败。** DSH 框架把工具结果作为单独的 `role:"tool"` 消息投递。会转换该结构的宿主适配器可以工作；而原样转发该 role 的适配器会被 OpenAI Responses（`Invalid value: 'tool'`）和 Anthropic（`Unexpected role "tool"`）拒绝。此时该 provider 上所有路由在插件看来都只是 `UNAVAILABLE_AT_PROBE`，而纯文本调用却成功，因此资格验证失败可能描述的是宿主而不是模型。

[在启用付费调用或项目写入之前，请先阅读安全与限制指南。](docs/SECURITY-AND-LIMITS.zh.md)

## 验证与开发 <a id="validation-and-development"></a>

对于 v1.14.0 评审修复快照，本地 Windows/Node 26.9.0 运行通过了 **224 个测试**，没有失败或跳过。针对性回归测试先在修复前的源码上运行，以确认所报告的问题。一次独立的源码评审在该差异中没有发现遗留的阻断问题。这些都不是正确性的证明，也不能替代 CI。

CI 配置为 **Linux、Windows 与 macOS 上的 Node 22 和 24**。请查看 CI 徽章或具体提交的运行结果；配置了矩阵并不意味着每一支都已通过。实时基准测试是与离线套件相互独立的证据，且只覆盖其声明的任务与快照。

在完整检出目录中：

```sh
node scripts/manifest.mjs --check
node scripts/verify.mjs
npm test
```

有意修改随包文件的贡献者必须用 `node scripts/manifest.mjs` 重新生成清单、检查差异并再次校验。不要把 `.local/`、凭据和状态提交到仓库。参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档 <a id="documentation"></a>

- [START-HERE.md](START-HERE.zh.md) — 最短的安装路径。
- [INSTALL-WITH-AI.md](INSTALL-WITH-AI.zh.md) — 给助手使用的有作用域安装说明。
- [使用指南](docs/USAGE.zh.md) — 工具参数、限制、评审循环与恢复。
- [治理](docs/GOVERNANCE.md) — 需显式启用的六阶段门禁、人工命令、诊断与限制。
- [架构](docs/ARCHITECTURE.md) — 宿主整合与持久化。
- [安全与限制](docs/SECURITY-AND-LIMITS.zh.md) — 权限、支出与保留的状态。
- [基准测试](docs/BENCHMARK.md) — 测得的 token／延迟结果与限制。
- [设计说明](docs/DESIGN-NOTES.md) — 设计理由与历史实验，不是当前性能保证。
- [变更日志](CHANGELOG.md) — 按版本记录的行为变更。
- [示例项目提示词](examples/PROJECT-PROMPT.md) — 有作用域工作的起点。
- [安全报告](SECURITY.md) · [Issues](https://github.com/WDahah/portable-dsh-multi-agent-plugin/issues)
