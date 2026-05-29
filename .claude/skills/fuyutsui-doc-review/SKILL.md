---
name: fuyutsui-doc-review
description: 多代理协作审核 Fuyutsui 说明文档。当用户需要审核、审查、检查 Fuyutsui 项目的文档（如"玩家光环"、"技能冷却"、"截图原理"、"队友状态"等主题的 readme.md）时触发。用户必须指定文档目录名称。此技能使用 Workflow 启动 9 个 Agent 进行并行审查、差异交叉验证和最终修改。
---

# Fuyutsui 文档审核

多代理（Multi-Agent）协作审核流程，系统性审查 Fuyutsui 项目的中文说明文档。

## 前置条件

- 用户必须指定要审核的文档目录名称（如 `玩家光环`、`技能冷却`、`截图原理`）
- 该目录下必须存在 `readme.md`
- **绝不**修改 `Fuyutsui/` 目录下的任何源码文件

## 执行方式

从用户消息中提取文档目录名称（`docName`），然后调用 Workflow 工具，传入 `args: {docName: "提取到的目录名"}` 和以下 workflow 脚本。

如果用户没有指定文档名称，先询问用户要审核哪个文档。

## Workflow 脚本

```javascript
export const meta = {
  name: 'fuyutsui-doc-review',
  description: '多Agent协作审核Fuyutsui文档：Alpha/Beta/Gamma并行审查 → Delta差异分析（一审共通项）→ Epsilon/Zeta/Eta复查 → 二审共通项汇总 → Theta综合审核（含一审二审共通项）→ Iota修改文档',
  phases: [
    { title: '独立审查', detail: 'Alpha、Beta、Gamma 并行审查文档与源码' },
    { title: '差异分析', detail: 'Delta 比较三方审查结论，区分共同发现与差异' },
    { title: '差异复查', detail: 'Epsilon、Zeta、Eta 对差异点进行独立复查' },
    { title: '综合审核', detail: 'Theta 综合一审共通项、二审共通项及全部复查结论，给出最终修改意见' },
    { title: '文档修改', detail: 'Iota 按审核意见修改文档' },
  ],
};

const docName = args.docName;
const BASE = 'E:/Desktop/FuyutsuiCopilot';

// ============================================================
// 共享 Schema
// ============================================================

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '唯一标识，格式如 A1, A2...' },
          type: { type: 'string', enum: ['错误', '遗漏'] },
          description: { type: 'string', description: '问题的详细描述（中文）' },
          evidence: { type: 'string', description: '源码文件路径和行号作为证据' },
          severity: { type: 'string', enum: ['高', '中', '低'] },
        },
        required: ['id', 'type', 'description', 'evidence', 'severity'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string', description: '对应差异点的 id' },
          confirmed: { type: 'boolean', description: '该差异点是否属实' },
          reasoning: { type: 'string', description: '判断理由，引用源码证据' },
          correction: { type: 'string', description: '如果不属实，说明正确的行为是什么' },
        },
        required: ['findingId', 'confirmed', 'reasoning'],
      },
    },
  },
  required: ['verdicts'],
};

const DELTA_SCHEMA = {
  type: 'object',
  properties: {
    common: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          type: { type: 'string', enum: ['错误', '遗漏'] },
          severity: { type: 'string', enum: ['高', '中', '低'] },
          evidence: { type: 'string' },
          found_by: { type: 'array', items: { type: 'string' } },
        },
        required: ['description', 'type', 'severity', 'evidence', 'found_by'],
      },
    },
    differences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['错误', '遗漏'] },
          severity: { type: 'string', enum: ['高', '中', '低'] },
          evidence: { type: 'string' },
          found_by: { type: 'string' },
          possible_reason: { type: 'string' },
        },
        required: ['id', 'description', 'type', 'severity', 'evidence', 'found_by'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['common', 'differences', 'summary'],
};

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    modifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', description: '需要修改的文档段落/小节' },
          issue: { type: 'string', description: '当前存在的问题' },
          suggestion: { type: 'string', description: '具体修改建议（可直接执行）' },
          priority: { type: 'string', enum: ['必须修改', '建议修改', '可选'] },
        },
        required: ['section', 'issue', 'suggestion', 'priority'],
      },
    },
  },
  required: ['modifications'],
};

// ============================================================
// 共享提示词模板
// ============================================================

const REVIEW_PROMPT = (role) => `你是一名严谨的 Fuyutsui 文档审核专家，代号 **${role}**。

## 任务
审查文档 \`${docName}/readme.md\` 的准确性和完整性，找出其中的**错误**和**遗漏**。

## 执行步骤

### 第一步：精读文档
路径：\`${BASE}/${docName}/readme.md\`
理解文档描述的主题、结构和每个技术细节。

### 第二步：阅读源码
在 \`${BASE}/Fuyutsui/\` 目录下找到与文档主题相关的源码文件并仔细阅读。
- 核心板条逻辑：\`Fuyutsui/core/\`
- 职业相关：\`Fuyutsui/class/\`
- 查找相关源码时使用 Grep 搜索关键词，不要猜测。

### 第三步：交叉验证
逐条检查文档描述是否与源码行为一致：
- **错误**：文档描述与源码实际行为不一致
- **遗漏**：源码中存在、对 mod 开发有重要意义但文档未覆盖的行为
- 如果文档声明了某种行为，必须在源码中找到对应实现；如果找不到或实现不同，那就是错误
- 如果源码中的重要函数/事件/配置没有在文档中说明，那就是遗漏

## 输出格式
返回一个 JSON，每项包含：
- \`id\`: 唯一标识（如 A1, A2...）
- \`type\`: "错误" 或 "遗漏"
- \`description\`: 详细描述
- \`evidence\`: 引用的源码路径和关键行号
- \`severity\`: "高"/"中"/"低"

## 重要规则
- **不要修改** Fuyutsui/ 目录下的任何文件（这是 AGENTS.md 的强制规定）
- 每条发现都必须有源码证据支撑
- 宁缺毋滥，只报告经过确认的问题
- 优先关注会影响 mod 开发者理解的内容`;

// ============================================================
// 阶段一：并行独立审查
// ============================================================
phase('独立审查');

const reviewers = await parallel([
  () => agent(REVIEW_PROMPT('Alpha'), { label: 'Alpha审查', phase: '独立审查', schema: FINDINGS_SCHEMA }),
  () => agent(REVIEW_PROMPT('Beta'),  { label: 'Beta审查',  phase: '独立审查', schema: FINDINGS_SCHEMA }),
  () => agent(REVIEW_PROMPT('Gamma'), { label: 'Gamma审查', phase: '独立审查', schema: FINDINGS_SCHEMA }),
]);

const [alphaRes, betaRes, gammaRes] = reviewers;
const alphaFindings = alphaRes?.findings || [];
const betaFindings  = betaRes?.findings  || [];
const gammaFindings = gammaRes?.findings || [];

log(`Alpha 发现 ${alphaFindings.length} 个问题，Beta 发现 ${betaFindings.length} 个，Gamma 发现 ${gammaFindings.length} 个`);

// ============================================================
// 阶段二：差异分析
// ============================================================
phase('差异分析');

const deltaResult = await agent(
  `你是一名 Fuyutsui 文档审核的**首席分析师**，代号 **Delta**。

## 任务
比较 Alpha、Beta、Gamma 三位审查专家的发现，分析一致性和差异。

## 输入

### Alpha 的发现：
${JSON.stringify(alphaFindings, null, 2)}

### Beta 的发现：
${JSON.stringify(betaFindings, null, 2)}

### Gamma 的发现：
${JSON.stringify(gammaFindings, null, 2)}

## 分析要求

### 第一步：语义去重与归类
不同审查者可能用不同措辞描述同一个问题。你需要：
1. 通过比较 description、evidence、涉及的主题来判断两个发现是否指向同一个问题
2. 将指向同一问题的发现归为一组

### 第二步：分类
- **共同发现**（共识）：至少 2 位审查者独立指出了同一问题 → 高置信度
- **差异发现**（分歧）：只有 1 位审查者提出了该问题 → 需要复查验证

### 第三步：对每个差异点说明分歧原因
- 是该审查者发现了一个真实但别人遗漏的问题？
- 还是该审查者误判了（可能是对源码理解有偏差）？

## 输出格式
返回 JSON：
\`\`\`json
{
  "common": [
    {
      "description": "问题描述",
      "type": "错误/遗漏",
      "severity": "高/中/低",
      "evidence": "各方引用的源码证据汇总",
      "found_by": ["Alpha", "Beta"]
    }
  ],
  "differences": [
    {
      "id": "原始 finding id",
      "description": "问题描述",
      "type": "错误/遗漏",
      "severity": "高/中/低",
      "evidence": "原始引用的证据",
      "found_by": "Alpha",
      "possible_reason": "为什么只有这个人发现"
    }
  ],
  "summary": "综合分析：本次审查共发现 X 个共识问题和 Y 个差异问题..."
}
\`\`\``,
  { label: 'Delta差异分析', phase: '差异分析', schema: DELTA_SCHEMA }
);

const common = deltaResult?.common || [];
const differences = deltaResult?.differences || [];
log(deltaResult?.summary || '');

log(`共识问题 ${common.length} 个，差异问题 ${differences.length} 个`);

// ============================================================
// 阶段三：差异复查
// ============================================================
phase('差异复查');

let reviewResults = [];
let reviewCommon = [];
if (differences.length > 0) {
  const diffsJson = JSON.stringify(differences, null, 2);

  const REVIEW_DIFF_PROMPT = (role) => `你是一名 Fuyutsui 文档审核的**复查专家**，代号 **${role}**。

## 任务
对 Delta 分析出的差异点进行独立复查，判断每个差异点是否属实。

## 差异点列表
${diffsJson}

## 复查要求

对每个差异点，执行以下操作：
1. **阅读文档**：\`${BASE}/${docName}/readme.md\` 中相关段落
2. **阅读源码**：检查该差异点引用的源码证据是否正确
3. **独立判断**：该差异点是否是真实的问题？

## 输出格式
返回 JSON，包含每个差异点的复查结论：
- \`findingId\`: 差异点的 id
- \`confirmed\`: true（属实）/ false（不属实）
- \`reasoning\`: 判断理由，必须引用源码
- \`correction\`: 如果不属实，说明正确的行为是什么（可选）`;

  const reReviewers = await parallel([
    () => agent(REVIEW_DIFF_PROMPT('Epsilon'), { label: 'Epsilon复查', phase: '差异复查', schema: VERDICT_SCHEMA }),
    () => agent(REVIEW_DIFF_PROMPT('Zeta'),    { label: 'Zeta复查',    phase: '差异复查', schema: VERDICT_SCHEMA }),
    () => agent(REVIEW_DIFF_PROMPT('Eta'),     { label: 'Eta复查',     phase: '差异复查', schema: VERDICT_SCHEMA }),
  ]);

  reviewResults = reReviewers.filter(Boolean).map(r => r?.verdicts || []).flat();
  log(`复查完成，共 ${reviewResults.length} 条复查意见`);

  // 汇总 Epsilon/Zeta/Eta 二审共通项：按 findingId 分组，统计每位复查者的确认情况
  const reviewByFinding = {};
  for (const v of reviewResults) {
    if (!reviewByFinding[v.findingId]) reviewByFinding[v.findingId] = { confirmed: 0, total: 0, reasons: [] };
    reviewByFinding[v.findingId].total++;
    if (v.confirmed) {
      reviewByFinding[v.findingId].confirmed++;
      reviewByFinding[v.findingId].reasons.push(v.reasoning);
    }
  }
  reviewCommon = [];
  for (const [findingId, info] of Object.entries(reviewByFinding)) {
    if (info.confirmed >= 2) {
      const diff = differences.find(d => d.id === findingId);
      reviewCommon.push({
        findingId,
        description: diff?.description || '(unknown)',
        confirmed_count: info.confirmed,
        total_reviewers: info.total,
        reasoning_summary: info.reasons.join(' | '),
      });
    }
  }
  log(`二审共通项 ${reviewCommon.length} 个（Epsilon/Zeta/Eta 中 ≥2 位确认属实）`);
} else {
  log('无差异点需要复查');
}

// ============================================================
// 阶段四：综合审核
// ============================================================
phase('综合审核');

const thetaPrompt = `你是一名资深的 Fuyutsui 架构师，代号 **Theta**。

## 任务
综合所有审查和复查结论，对文档 \`${docName}/readme.md\` 给出最终修改意见。

## 输入材料

### 一审共识问题（Alpha、Beta、Gamma 中 ≥2 位共同发现，高置信度）：
${JSON.stringify(common, null, 2)}

### 二审共通项（Epsilon、Zeta、Eta 中 ≥2 位确认属实的差异点）：
${JSON.stringify(reviewCommon, null, 2)}

### 差异复查原始结论（全部）：
${JSON.stringify(reviewResults, null, 2)}

### 原始差异点：
${JSON.stringify(differences, null, 2)}

## 审核步骤

### 第一步：验证一审共识问题
快速阅读 \`${BASE}/Fuyutsui/\` 下相关源码，验证一审共识问题是否确实存在。
如果某个"共识"在源码层面站不住脚，标注为误判并说明原因。

### 第二步：裁定差异问题
二审共通项中 ≥2 位复查者已确认属实的差异点视为高置信度，优先纳入修改列表。
你仍需对以下情况进行独立裁决：
- 若某差异点不在二审共通项中（三方意见不一致或多数认为不属实），你必须亲自阅读源码做出最终裁决
- 即使某差异点在二审共通项中，若你发现复查者的推理存在明显漏洞，也可以推翻并说明原因

### 第三步：补充审查
基于你对 Fuyutsui 源码的全面理解，检查是否还有 Alpha/Beta/Gamma 和 Epsilon/Zeta/Eta 都遗漏的重要问题。
如果有，追加到修改列表中。

### 第四步：生成修改意见
按文档段落组织修改建议，每条建议包含：
- \`section\`: 文档中需要修改的段落/小节名称
- \`issue\`: 当前存在的问题
- \`suggestion\`: 具体的修改方案（文字可直接使用）
- \`priority\`: "必须修改" / "建议修改" / "可选"

## 重要提醒
- 结合知识：你可能知道所有审查者都不了解的源码细节
- 不要修改 Fuyutsui/ 下的任何文件
- 修改建议要具体、可操作`;

const thetaResult = await agent(thetaPrompt, {
  label: 'Theta综合审核',
  phase: '综合审核',
  schema: FINAL_SCHEMA,
});

const modifications = thetaResult?.modifications || [];
log(`Theta 审核完成，共 ${modifications.length} 条修改意见`);
log(`必须修改: ${modifications.filter(m => m.priority === '必须修改').length} 条`);
log(`建议修改: ${modifications.filter(m => m.priority === '建议修改').length} 条`);
log(`可选: ${modifications.filter(m => m.priority === '可选').length} 条`);

// ============================================================
// 阶段五：文档修改
// ============================================================
phase('文档修改');

await agent(
  `你是一名 Fuyutsui 文档编辑，代号 **Iota**。

## 任务
根据 Theta 的最终审核意见，修改文档 \`${BASE}/${docName}/readme.md\`。

## 修改意见
${JSON.stringify(modifications, null, 2)}

## 修改规则

1. **先读取再修改**：读取 \`${BASE}/${docName}/readme.md\` 的完整内容
2. **逐条修改**：按照 Theta 的意见逐条修改文档
3. **保持格式**：保持文档原有的 Markdown 格式和结构
4. **只改必要之处**：不重写整个文档，只修改有问题或遗漏的部分
5. **标注修改**：每条修改后，在文档末尾添加"修订记录"小节（如不存在则创建），记录本次修改：
   - 修改位置（段落/小节）
   - 修改原因
   - 修改内容摘要
6. **不要修改 Fuyutsui/ 目录**：只修改 \`${BASE}/${docName}/readme.md\`

## 优先级执行
- "必须修改" → 全部修改
- "建议修改" → 全部修改
- "可选" → 酌情修改，以不破坏文档流畅性为准

完成后输出修改摘要，列出实际修改了哪些内容。`,

  { label: 'Iota修改文档', phase: '文档修改' }
);

log('========== Fuyutsui 文档审核完成 ==========');
log(`文档: ${docName}/readme.md`);
log(`一审共通: ${common.length} | 差异: ${differences.length} | 二审共通: ${reviewCommon.length} | 修改意见: ${modifications.length}`);
```

## 结果

Workflow 完成后，文档 `{文档名称}/readme.md` 已被修改。总结以下信息告知用户：
- 发现的问题数量和严重程度分布
- 实际修改了多少处
- 建议用户使用 `git diff` 查看具体变更
