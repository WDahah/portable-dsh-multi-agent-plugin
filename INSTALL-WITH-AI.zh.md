# 让任意有能力的 AI 助手完成安装

[English](INSTALL-WITH-AI.md) · **简体中文**

将整段提示词复制到你想用来协助安装的 AI 中。先替换三个方括号中的值。该 AI 必须能够检查本地文件和目标宿主；只有对话能力的 AI 可以解释步骤，但不能声称自己执行过这些步骤。

```text
在本机安装便携式 Multi-agent 文件夹，并让它与我选定的一个无关项目配合工作。

便携文件夹：<actual absolute folder path>
项目：<actual absolute project path>
初始项目目标：<concrete bounded task>

权限与范围：
- 查明实际的工作目录、操作系统与路径；不要沿用另一台机器的路径。
- 先阅读便携文件夹中的 README.md 和 docs/SECURITY-AND-LIMITS.md，然后阅读 START-HERE.md 和 docs/USAGE.md。
- 你可以运行离线 tests/setup/doctor，创建文档所述的本地入口与候选补丁，并在精确识别出当前生效的用户自有宿主补丁后，先备份再把必要的插件插入项合并进去。保留无关配置。
- 你可以使用公开的合成提示词运行少量有界实况资格验证，然后执行一个限定范围的只读验收任务。请说明这些调用可能消耗付费或订阅额度。无需我逐次批准每次调用的预算；$1 是软目标，不是上限。
- 本授权不会绕过宿主的沙箱、文件权限、审批策略、提供商条款或其他安全控制。如果这些控制拒绝某项操作，请报告并停止该操作。
- 安装期间不要删除文件、卸载提供商、复制旧状态或修改项目源码。项目工作从只读开始。除非我已提供明确的文件写入范围，否则在实施前先索要。

1. 确立真实的前置条件
- 确认 Node.js >=22，并检查 package.json 以及 scripts/setup.mjs 和 scripts/doctor.mjs。如果这些文件缺失，或其标志与文档不一致，请停止并报告该不一致；不要凭空编造脚本。
- 这是 DSH/Cordis 原生插件，不是独立的 agent 框架。查明现有的 DSH 版本、宿主组合、当前生效的用户 profile，以及实际安装的 dsh-tools/lib/index.js 模块。
- 如果缺少 DSH，请通过可用的文档工具查找当前的官方 DSH 安装指南，报告官方来源，并在具备必要授权的前提下只遵循该受支持流程。不要编造 npm 包名、版本或 CLI 命令。如果官方指南或兼容宿主不可用，请如实停止。
- 如果宿主提供确切的 Inspect API，请用它确认 tools、llm 和 subagents 服务及其签名。否则检查已安装的 API 约定。要求具备原生注册、已准备的 LLM 流式传输，以及限定范围的子 agent 启动/结果/释放；仅有模型名称或浏览器聊天窗口是不够的。
- 原始兼容性参照是 dsh-tools 0.1.5-rc.2/Cordis ^4.0.2，并非通用的跨版本保证。在做资格验证前，请对照已安装的适配器目录确认每条路由的 provider id 和确切 model id：目录未描述的模型会以纯文本路由的方式提供，而 provider id 命名的是特定接口面（Kimi Code 订阅端点与 Moonshot 开放平台），二者不可互换。

2. 在本地完成准备，不靠推断
- 复制完整的最终文件夹后，先运行 node scripts/verify.mjs。它会读取 portable-manifest.json，检查清单所列文件的哈希，以发现被修改或缺失的文件。它不是签名或真实性证明，也不会拒绝未列入清单的额外文件。清单缺失或检查失败时请停止；不要重新生成清单来掩盖不一致。该命令离线运行，不会对模型做资格验证。
- 在便携文件夹中运行 npm test。这些是离线合成测试，不是实况模型资格验证。本包基于 Node 内置实现，无需 npm install；这不会安装 DSH。
- 为本次安装选择一个绝对、全新且私有的状态目录。绝不要复制另一台机器的 .local 入口、凭据、账号文件、资格记录或任务日志。
- 运行：
  node scripts/setup.mjs --tools-module "<actual-host-dsh-tools/lib/index.js>" --state-root "<absolute fresh state directory>"
- state-root 标志是可选的；这里显式使用它。--tools-module 和 --harness-root 只能提供其中一个。用于探测发现时，请把 --tools-module 选项换成 --harness-root "<absolute installed host directory>"；不要同时提供两者，也不要猜测模块路径。
- 运行 node scripts/doctor.mjs，如果其实际约定要求，可带上它可选的 tools-module 参数。
- 检查生成的 .local/entry.mjs 和 .local/host-patch.yml。Setup 只生成这两个产物，不会编辑生效中的 profile。Doctor 离线运行，不能证明认证、提供商调用成功或运行时已激活。

3. 通过实际的用户宿主组合完成激活
- 在修改之前，先识别并备份当前生效的用户自有宿主补丁。不要编辑随包发布的 preset 目录或旧的部署/源码安装。
- 比对现有的插件条目和可见的 orchestrator_* 工具。不要安装重复的工具注册。如果较旧的 orchestrator 发生冲突，请查明其确切条目、归属和回滚映射；只有在我的安装授权范围内、并有备份时，才禁用那个旧条目。如果你无法可靠地识别它，请停止，而不是大范围删除或改写。
- 将生成的根插入项合并到现有补丁中，不要整体替换，也不要破坏无关条目。遵循宿主支持的重新加载/重启方式；不要启动替代的 GUI 服务器。
- 验证该入口确实被加载，且预期的十五个 orchestrator 工具可见。磁盘上的文件、候选 YAML 补丁或 doctor 成功结果都不是运行时证据。
- 保留备份，并说明如何禁用或回滚所添加的那个特定条目。除非确有需要且获得授权，否则不要执行回滚。

4. 发现并为本机的路由做资格验证
- 阅读 src/routes.mjs。其中的标识符和 effort 预期是随部署而变的候选项，不是通用可用性声明。
- 通过真实宿主已注册的服务获取 provider/model 清单，包括 listModels，以及在支持的情况下获取确切的 model/effort 约定。不要打印凭据或完整的设置对象。
- 只通过宿主认可的 UI 或官方认证流程进行认证。绝不要在聊天中索要 API 密钥、剪贴板转储或复制的账号文件。
- 不要编造提供商、别名、effort 支持或资格证据。如果宿主使用不同的 ID，请提出一项明确的映射变更，覆盖 ROUTES、POOL_PRIORITY、预期 efforts 和相关测试；取得所需的额外源码编辑授权后，再重新对它做资格验证。不要静默替换成相似模型，也不要把合成夹具变成实况记录。
- 在将要派发本项目工作的同一根 agent 会话中，调用 orchestrator_inventory，并只对所需的精确 route/effort 组合运行 orchestrator_qualify。每个组合都必须通过真实的原生子 agent 文本/工具回声挑战。证据按 owner/会话限定作用域，并在 24 小时后过期；新的项目/会话必须建立自己的证据。
- 将失败、不受支持或未认证的路由标记为不可用，并记录观察到的结果。不要自动反复重试失败的探测，不要卸载提供商，也不要在只有一条路由通过时声称所有池都已就绪。
- 通用的文本/工具冒烟测试不等于图像或专业领域资格验证。`vision` 角色需要图像证据；`domain` 角色需要领域证据。普通规划、编码或评审请使用 `standard` 或 `deep`，不要贴上虚假的专业标签。

5. 安全地验证并开始所选项目
- 把 examples/task.json 当作 TASK METADATA（任务元数据），而不是整个工具请求。对于初始的只读委派，调用 orchestrator_delegate，并传入唯一的 run_id、该 task 对象、一个写明实际项目、允许的读取路径、停止条件和预期输出的完整 prompt，以及 allowed_tools ["read","glob","grep"]。
- 使用 orchestrator_delegate_read 核实所选的 provider/model/effort、返回的子 agent 身份、已保存的输出和终止状态。不要仅仅因为 npm test 通过就声称所有真实测试都已通过。
- 对于 direct-model 续跑，使用 orchestrator_plan -> orchestrator_run -> orchestrator_read。只恢复已被证明安全的已结算状态；绝不要重置或重放状态不确定的 task ID。新的诊断任务不能作为先前失败已解决的证据。
- 保持项目写入的范围受控。仅对明确授权的实施添加 write/edit；只有在必要且获许可时才使用 pwsh。会改动文件的工作不得在触及 token 上限或发生未知中断后自动重复。
- 不要仅仅因为多 agent 有用就调用 workflow 工具。请使用原生 orchestrator 委派工具；只有在明确要求且受支持时才使用 workflow 工具。

分别报告：
A. 离线测试与生成的候选产物。
B. 已验证的宿主激活情况和确切的已安装条目。
C. 新的实况资格验证：通过/失败的 route-effort 组合，以及 owner/会话作用域。
D. 实际的项目验收结果与输出保存位置。
E. 仍存在的限制、未知成本、状态目录与回滚备份。

如果未观察到必需的阶段，就不要声称安装/使用成功。遇到宿主缺失/不兼容、profile 歧义不安全、权限被拒，或任务没有合格路由时，请停止。保留部分输出并说明具体的限制，而不是编造成功。
```
