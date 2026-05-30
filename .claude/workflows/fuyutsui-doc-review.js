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
// Shared Schema
// ============================================================

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique id, format: A1, A2...' },
          type: { type: 'string', enum: ['错误', '遗漏'] },
          description: { type: 'string', description: 'Detailed description in Chinese' },
          evidence: { type: 'string', description: 'Source file paths and behavioral description (describe what the code does, not line numbers)' },
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
          findingId: { type: 'string' },
          confirmed: { type: 'boolean' },
          reasoning: { type: 'string' },
          correction: { type: 'string' },
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
          section: { type: 'string' },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
          priority: { type: 'string', enum: ['必须修改', '建议修改', '可选'] },
        },
        required: ['section', 'issue', 'suggestion', 'priority'],
      },
    },
  },
  required: ['modifications'],
};

// ============================================================
// Phase 1: Parallel independent review
// ============================================================
phase('独立审查');

function buildReviewPrompt(role) {
  return [
    'You are a rigorous Fuyutsui documentation review expert, codename ' + role + '.',
    '',
    '## Task',
    'Review the document `' + docName + '/readme.md` for accuracy and completeness, finding errors and omissions.',
    '',
    '## Steps',
    '',
    '### Step 1: Read the document',
    'Path: `' + BASE + '/' + docName + '/readme.md`',
    'Understand the topic, structure, and every technical detail.',
    '',
    '### Step 2: Read the source code',
    'Find relevant source files under `' + BASE + '/Fuyutsui/`.',
    '- Core bar logic: `Fuyutsui/core/`',
    '- Class-related: `Fuyutsui/class/`',
    '- Use Grep to search keywords; do not guess.',
    '',
    '### Step 3: Cross-validate',
    'Check each claim in the document against source code:',
    '- **错误 (Error)**: Document claims something that contradicts the source code.',
    '- **遗漏 (Omission)**: Source code has important behavior/feature for mod developers that the document does not cover.',
    '- If the document claims a behavior, you MUST find its implementation in source; if not found or different, it is an error.',
    '- If important functions/events/config in source are not explained in the document, that is an omission.',
    '',
    '## Principle over Line Numbers',
    'Documentation should explain **what the code does and why**, not **where a line sits in a file**. Line numbers change with every commit and are useless to readers. When reviewing:',
    '- Describe behavior: what function/event/module is responsible, what data it consumes, what output it produces.',
    '- Cite source FILE paths for traceability, but avoid pinning claims to specific line numbers.',
    '- If a finding hinges on a single-line detail, describe the logic at that location instead of quoting the line number.',
    '',
    '## Output Format',
    'Return a JSON object with a `findings` array. Each finding: id, type (错误/遗漏), description, evidence, severity (高/中/低).',
    '',
    '## Important Rules',
    '- Do NOT modify any files under Fuyutsui/ (AGENTS.md rule).',
    '- Every finding must have source code evidence (behavior-level, not line numbers).',
    '- Only report confirmed issues; quality over quantity.',
    '- Focus on content that affects mod developer understanding.',
  ].join('\n');
}

const reviewers = await parallel([
  function() { return agent(buildReviewPrompt('Alpha'), { label: 'Alpha审查', phase: '独立审查', schema: FINDINGS_SCHEMA }); },
  function() { return agent(buildReviewPrompt('Beta'),  { label: 'Beta审查',  phase: '独立审查', schema: FINDINGS_SCHEMA }); },
  function() { return agent(buildReviewPrompt('Gamma'), { label: 'Gamma审查', phase: '独立审查', schema: FINDINGS_SCHEMA }); },
]);

const alphaFindings = (reviewers[0] && reviewers[0].findings) ? reviewers[0].findings : [];
const betaFindings  = (reviewers[1] && reviewers[1].findings) ? reviewers[1].findings : [];
const gammaFindings = (reviewers[2] && reviewers[2].findings) ? reviewers[2].findings : [];

log('Alpha found ' + alphaFindings.length + ' issues, Beta found ' + betaFindings.length + ', Gamma found ' + gammaFindings.length);

// ============================================================
// Phase 2: Delta difference analysis
// ============================================================
phase('差异分析');

function buildDeltaPrompt(alpha, beta, gamma) {
  return [
    'You are the Chief Analyst of Fuyutsui documentation review, codename **Delta**.',
    '',
    '## Task',
    'Compare findings from Alpha, Beta, Gamma reviewers and analyze consensus vs differences.',
    '',
    '## Alpha Findings:',
    JSON.stringify(alpha, null, 2),
    '',
    '## Beta Findings:',
    JSON.stringify(beta, null, 2),
    '',
    '## Gamma Findings:',
    JSON.stringify(gamma, null, 2),
    '',
    '## Analysis Requirements',
    '',
    '### Step 1: Semantic dedup and grouping',
    'Different reviewers may describe the same issue with different words. Group findings that point to the same underlying issue by comparing descriptions, evidence, and topic.',
    '',
    '### Step 2: Classification',
    '- **Triple consensus**: All 3 reviewers independently found the same issue → highest confidence, found_by must be ["Alpha", "Beta", "Gamma"]',
    '- **Dual consensus**: 2 reviewers found the same issue → high confidence',
    '- **Differences**: Only 1 reviewer raised the issue → needs re-verification',
    '',
    '### Step 3: Explain divergence',
    'For each difference, explain: did the reviewer find a real issue others missed, or did they misinterpret the source?',
    '',
    '## Output Format',
    'Return JSON with common (consensus issues), differences (single-reviewer findings), and summary fields.',
    'Common items: description, type, severity, evidence, found_by array (2 or 3 reviewer names).',
    'Difference items: id, description, type, severity, evidence, found_by (single name), possible_reason.',
  ].join('\n');
}

const deltaResult = await agent(
  buildDeltaPrompt(alphaFindings, betaFindings, gammaFindings),
  { label: 'Delta差异分析', phase: '差异分析', schema: DELTA_SCHEMA }
);

const common = (deltaResult && deltaResult.common) ? deltaResult.common : [];
const differences = (deltaResult && deltaResult.differences) ? deltaResult.differences : [];
if (deltaResult && deltaResult.summary) {
  log(deltaResult.summary);
}

log('Consensus issues: ' + common.length + ', Difference issues: ' + differences.length);

// ============================================================
// Phase 3: Difference re-review
// ============================================================
phase('差异复查');

var reviewResults = [];
var reviewCommon = [];
if (differences.length > 0) {
  var diffsJson = JSON.stringify(differences, null, 2);

  function buildReReviewPrompt(role) {
    return [
      'You are a Fuyutsui documentation re-review expert, codename **' + role + '**.',
      '',
      '## Task',
      'Independently re-examine the difference findings from Delta analysis and judge whether each is valid.',
      '',
      '## Difference Findings:',
      diffsJson,
      '',
      '## Steps',
      'For each difference, (1) read the relevant doc section in `' + BASE + '/' + docName + '/readme.md`, (2) verify the cited source evidence, (3) make an independent judgment.',
      '',
      '## Output Format',
      'Return JSON with a `verdicts` array. Each: findingId, confirmed (boolean), reasoning (with source evidence), correction (if not confirmed, state correct behavior).',
    ].join('\n');
  }

  var reReviewers = await parallel([
    function() { return agent(buildReReviewPrompt('Epsilon'), { label: 'Epsilon复查', phase: '差异复查', schema: VERDICT_SCHEMA }); },
    function() { return agent(buildReReviewPrompt('Zeta'),    { label: 'Zeta复查',    phase: '差异复查', schema: VERDICT_SCHEMA }); },
    function() { return agent(buildReReviewPrompt('Eta'),     { label: 'Eta复查',     phase: '差异复查', schema: VERDICT_SCHEMA }); },
  ]);

  reReviewers.filter(Boolean).forEach(function(r) {
    if (r && r.verdicts) {
      reviewResults = reviewResults.concat(r.verdicts);
    }
  });
  log('Re-review complete, ' + reviewResults.length + ' verdicts');

  // Aggregate Epsilon/Zeta/Eta second-round common findings
  var reviewByFinding = {};
  reviewResults.forEach(function(v) {
    if (!reviewByFinding[v.findingId]) {
      reviewByFinding[v.findingId] = { confirmed: 0, total: 0, reasons: [] };
    }
    reviewByFinding[v.findingId].total++;
    if (v.confirmed) {
      reviewByFinding[v.findingId].confirmed++;
      reviewByFinding[v.findingId].reasons.push(v.reasoning);
    }
  });

  Object.keys(reviewByFinding).forEach(function(findingId) {
    var info = reviewByFinding[findingId];
    if (info.confirmed >= 2) {
      var diff = differences.find(function(d) { return d.id === findingId; });
      reviewCommon.push({
        findingId: findingId,
        description: (diff && diff.description) ? diff.description : '(unknown)',
        confirmed_count: info.confirmed,
        total_reviewers: info.total,
        reasoning_summary: info.reasons.join(' | '),
      });
    }
  });
  log('Second-round common findings: ' + reviewCommon.length + ' (confirmed by >=2 of Epsilon/Zeta/Eta)');
} else {
  log('No differences to re-review');
}

// ============================================================
// Phase 4: Theta comprehensive review
// ============================================================
phase('综合审核');

function buildThetaPrompt(commonIssues, reviewCommonIssues, allVerdicts, allDiffs) {
  return [
    'You are a senior Fuyutsui architect, codename **Theta**.',
    '',
    '## Task',
    'Synthesize all review and re-review conclusions and produce final modification suggestions for `' + docName + '/readme.md`.',
    '',
    '## Input Materials',
    '',
    '### First-round Consensus Issues (found by >=2 of Alpha/Beta/Gamma):',
    'Note: found_by with ["Alpha","Beta","Gamma"] means triple consensus.',
    JSON.stringify(commonIssues, null, 2),
    '',
    '### Second-round Common Findings (confirmed by >=2 of Epsilon/Zeta/Eta):',
    JSON.stringify(reviewCommonIssues, null, 2),
    '',
    '### All Re-review Verdicts:',
    JSON.stringify(allVerdicts, null, 2),
    '',
    '### Original Differences:',
    JSON.stringify(allDiffs, null, 2),
    '',
    '## Review Steps',
    '',
    '### Step 0: Triple consensus must be included (hard rule)',
    'ANY issue with found_by = ["Alpha","Beta","Gamma"] MUST be included in modifications, regardless of severity. Priority must be at least "必须修改". Three independent eyes seeing the same issue means it matters.',
    '',
    '### Step 1: Verify dual consensus',
    'Check issues found by exactly 2 reviewers against source. If a dual-consensus issue is not supported by source, flag it as a false positive with explanation.',
    '',
    '### Step 2: Judge differences',
    'For differences confirmed by >=2 re-reviewers, prioritize them. For differences NOT in the second-round common list (re-reviewers disagreed or majority said false), you must independently read the source and make a final ruling. You can override re-reviewer conclusions if their reasoning is flawed.',
    '',
    '### Step 3: Supplemental review',
    'Based on your comprehensive understanding of Fuyutsui source, check if any important issues were missed by ALL of Alpha/Beta/Gamma and Epsilon/Zeta/Eta. Add them if found.',
    '',
    '### Step 4: Generate modification suggestions',
    'Organize by document section. Each: section, issue, suggestion (actionable text), priority (必须修改/建议修改/可选).',
    '',
    '## Writing Principles for Suggestions',
    '- **Describe behavior, not coordinates**: Write about what the code does, what triggers it, and what it produces. Do NOT cite specific line numbers — they will be stale by the next commit.',
    '- **Answer "how does this work?"** not "where is this line?". Mod developers need to understand the mechanism.',
    '- When referencing source code, mention file paths and function/module names, never line numbers.',
    '',
    '## Important',
    '- Do NOT modify files under Fuyutsui/.',
    '- Be specific and actionable.',
  ].join('\n');
}

var thetaResult = await agent(
  buildThetaPrompt(common, reviewCommon, reviewResults, differences),
  { label: 'Theta综合审核', phase: '综合审核', schema: FINAL_SCHEMA }
);

var modifications = (thetaResult && thetaResult.modifications) ? thetaResult.modifications : [];
log('Theta review complete: ' + modifications.length + ' modification suggestions');
log('必须修改: ' + modifications.filter(function(m) { return m.priority === '必须修改'; }).length);
log('建议修改: ' + modifications.filter(function(m) { return m.priority === '建议修改'; }).length);
log('可选: ' + modifications.filter(function(m) { return m.priority === '可选'; }).length);

// ============================================================
// Phase 5: Document editing
// ============================================================
phase('文档修改');

function buildIotaPrompt(mods) {
  return [
    'You are a Fuyutsui documentation editor, codename **Iota**.',
    '',
    '## Task',
    'Edit the document `' + BASE + '/' + docName + '/readme.md` according to Theta\'s final review suggestions.',
    '',
    '## Modification Suggestions',
    JSON.stringify(mods, null, 2),
    '',
    '## Editing Rules',
    '1. Read the full content of `' + BASE + '/' + docName + '/readme.md` first.',
    '2. Apply each modification suggestion one by one.',
    '3. Preserve the original Markdown format and structure.',
    '4. Only change what needs to change; do not rewrite the entire document.',
    '5. Add a "修订记录" (Revision History) section at the end of the document (or append to it if it already exists) recording each change: location, reason, summary.',
    '6. Do NOT modify files under Fuyutsui/. Only modify `' + BASE + '/' + docName + '/readme.md`.',
    '7. **No line numbers in documentation**:',
    '   - **Remove** any existing line number references you find in the document (e.g. "第 42 行", "L128", "line 256"). These are stale the moment they are written.',
    '   - **Replace** each removed line-number reference with a structural call-chain locator using the format: `文件名 > 类名 > 函数名 > 子函数名` (e.g. `core/bar.lua > BarManager > UpdateCooldown > CheckCharge`). This tells readers WHERE to look in the code hierarchy, not WHERE a line sits today.',
    '   - Omit any level that does not exist; the goal is the shortest unambiguous path from file to the relevant logic.',
    '   - If the document already uses call-chain style references, keep them; only convert line-number style references.',
    '   - The format is always `path/to/file > ClassName > function > sub_function` — describe the mechanism and its location in the code tree, not a coordinate on a screen.',
    '8. **Scope isolation — no cross-file risk**:',
    '   - You ONLY have permission to edit `' + BASE + '/' + docName + '/readme.md`. No other file is in your scope. The system physically cannot modify any other file, so there is zero risk of accidental cross-contamination.',
    '   - Other review teams may be running in parallel, each editing a different `主题目录/readme.md`. Your work is isolated to `' + docName + '`. Do not read, reference, or concern yourself with files in other topic directories.',
    '   - When the workflow completes, only `' + docName + '/readme.md` is your output. Commit ONLY this single file — do not stage or commit any other paths. If git detects other changed files, those belong to parallel teams; ignore them.',
    '',
    '## Priority Execution',
    '- "必须修改" → Apply all (including triple-consensus items).',
    '- "建议修改" → Apply all.',
    '- "可选" → Apply at discretion, keeping document flow intact.',
    '- Trust the priority judgments from Theta.',
    '',
    'When done, output a summary of what was actually changed.',
  ].join('\n');
}

await agent(
  buildIotaPrompt(modifications),
  { label: 'Iota修改文档', phase: '文档修改' }
);

log('========== Fuyutsui Documentation Review Complete ==========');
log('Document: ' + docName + '/readme.md');
log('First-round common: ' + common.length + ' | Differences: ' + differences.length + ' | Second-round common: ' + reviewCommon.length + ' | Modifications: ' + modifications.length);
