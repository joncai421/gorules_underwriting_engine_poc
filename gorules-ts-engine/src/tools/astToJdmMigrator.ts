import fs from 'node:fs';
import path from 'node:path';

/**
 * astToJdmMigrator.ts  (`npm run migrate`)
 *
 * Deterministic, zero-API-key migration helper that reads the LEGACY Java source
 * (HardcodedUnderwritingService.java) and rebuilds the complete four-stage GoRules
 * JDM graph at shared/rules/v1-migrated-rules.json.
 *
 * Dual-mode extractor (PRD v2 Requirement 3a):
 *   - Default: scrapes the machine-readable markers emitted by the legacy code —
 *       // UW_RULE s1 <docCode> | <reason>
 *       // UW_RULE s2 <ruleId> | <outcome> | <debits> | <exclusionCode|-> | <reason>
 *       // UW_RULE s3 <riskClass> | <table> | <finalDecision> | <loading> | <refer>
 *     plus a recursive-descent parse of the following `if (...)` boolean condition,
 *     normalized to DNF (OR-across-fields become one row per branch), producing the
 *     stage-1 / stage-2 / stage-3 decision tables. Stage 0/2.5 formulas and the stage-4
 *     formatter envelope are structural (not rule logic) and come from a validated
 *     zen-engine template.
 *   - `--llm-prompt`: emits a structured prompt + JSON Schema showing how an LLM would
 *     perform the same Java -> JDM conversion.
 */

const JAVA_FILE = path.resolve(__dirname, '..', '..', '..', 'legacy-java-service', 'src', 'main', 'java', 'com', 'poc', 'uw', 'service', 'HardcodedUnderwritingService.java');
const OUT_FILE = path.resolve(__dirname, '..', '..', '..', 'shared', 'rules', 'v1-migrated-rules.json');

type FieldMap = Record<string, string>;

const S1_MAP: FieldMap = {
  sumAssured: 'inf-sa',
  age: 'inf-age',
  bmi: 'inf-bmi',
  medicalConditions: 'inf-med',
  submittedDocuments: 'inf-docs',
};
const S2_MAP: FieldMap = {
  age: 'ra-age',
  bmi: 'ra-bmi',
  systolicBp: 'ra-bp',
  smoker: 'ra-smoker',
  incomeMultiple: 'ra-inc-mult',
  recentSurgeryMonthsAgo: 'ra-surg',
  medicalConditions: 'ra-med',
  occupationClass: 'ra-occ',
  avocations: 'ra-avoc',
};
const S3_MAP: FieldMap = {
  isSufficient: 'rc-suff',
  hasDeclineTrigger: 'rc-dec',
  hasPostponeTrigger: 'rc-post',
  hasExclusionTrigger: 'rc-excl',
  totalEmDebits: 'rc-debits',
  hasComorbidityUncleanTrigger: 'rc-unclean',
};
const STAGE_MAPS: Record<string, FieldMap> = { s1: S1_MAP, s2: S2_MAP, s3: S3_MAP };

interface Atom {
  field: string;
  cell: string;
}
type Node =
  | { kind: 'leaf'; atom: Atom }
  | { kind: 'or'; children: Node[] }
  | { kind: 'and'; children: Node[] };

// ---------------------------------------------------------------------------
// Tokenizer (structural tokens only; operands captured as atomic spans)
// ---------------------------------------------------------------------------
type Token =
  | { t: '&&' } | { t: '||' } | { t: '(' } | { t: ')' } | { t: '!' }
  | { t: 'atom'; v: string };

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf.trim()) toks.push({ t: 'atom', v: buf.trim() });
    buf = '';
  };
  while (i < src.length) {
    // Method-call parentheses (e.g. contains("X")) belong to the operand.
    if (src[i] === '(' && /\w$/.test(buf)) {
      buf += src[i];
      i++;
      let p = 1;
      while (i < src.length && p > 0) {
        if (src[i] === '(') p++;
        else if (src[i] === ')') p--;
        buf += src[i];
        i++;
      }
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      toks.push(two === '&&' ? { t: '&&' } : { t: '||' });
      i += 2;
      continue;
    }
    if (src[i] === '(') {
      flush();
      toks.push({ t: '(' });
      i++;
      continue;
    }
    if (src[i] === ')') {
      flush();
      toks.push({ t: ')' });
      i++;
      continue;
    }
    if (src[i] === '!' && src[i + 1] !== '=') {
      flush();
      toks.push({ t: '!' });
      i++;
      continue;
    }
    buf += src[i];
    i++;
  }
  flush();
  return toks;
}

// ---------------------------------------------------------------------------
// Leaf atom -> { field, cell }
// ---------------------------------------------------------------------------
function stripNumber(n: string): string {
  return n.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const FLIP: Record<string, string> = { '>': '<=', '<': '>=', '>=': '<', '<=': '>' };

function atomFromSpan(span: string, map: FieldMap, negate = false): Atom | null {
  const s = span.trim();

  // [!]field.contains("V")  (the tokenizer emits '!' as its own token, so negation
  // always arrives via the `negate` parameter)
  const contains = s.match(/^(\w+)\.contains\(\s*"([^"]+)"\s*\)$/);
  if (contains && map[contains[1]]) {
    return {
      field: contains[1],
      cell: negate ? `not(contains($, "${contains[2]}"))` : `contains($, "${contains[2]}")`,
    };
  }

  // field OP value
  const cmp = s.match(/^(\w+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (cmp) {
    const [, field, rawOp, rawVal] = cmp;
    if (!map[field]) return null;
    const val = rawVal.trim();
    const op = negate ? FLIP[rawOp] : rawOp;
    if (op === '==' || op === '!=') {
      if (val === 'true') return { field, cell: op === '==' ? 'true' : 'false' };
      if (val === 'false') return { field, cell: op === '==' ? 'false' : 'true' };
      return { field, cell: `${op === '!=' ? 'not ' : ''}${val}` };
    }
    if (/^-?\d+(\.\d+)?$/.test(val)) {
      return { field, cell: `${op} ${stripNumber(val)}` };
    }
    return { field, cell: `${op} ${val}` };
  }

  // bare boolean identifier (optionally negated)
  if (/^\w+$/.test(s) && map[s]) {
    return { field: s, cell: negate ? 'false' : 'true' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser -> AST -> DNF
// ---------------------------------------------------------------------------
function parseTokens(toks: Token[], map: FieldMap): Node {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parsePrimary(): Node {
    const t = peek();
    if (t && t.t === '(') {
      next();
      const inner = parseOr();
      if (peek() && peek().t === ')') next();
      return inner;
    }
    if (t && t.t === '!') {
      next();
      const operand = peek();
      if (operand && operand.t === 'atom') {
        next();
        const atom = atomFromSpan(operand.v, map, true);
        return atom ? { kind: 'leaf', atom } : { kind: 'and', children: [] };
      }
      return parsePrimary();
    }
    if (t && t.t === 'atom') {
      next();
      const atom = atomFromSpan(t.v, map);
      return atom ? { kind: 'leaf', atom } : { kind: 'and', children: [] };
    }
    next();
    return { kind: 'and', children: [] };
  }

  function parseAnd(): Node {
    const parts: Node[] = [parsePrimary()];
    while (peek() && peek().t === '&&') {
      next();
      parts.push(parsePrimary());
    }
    return parts.length === 1 ? parts[0] : { kind: 'and', children: parts };
  }

  function parseOr(): Node {
    const parts: Node[] = [parseAnd()];
    while (peek() && peek().t === '||') {
      next();
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : { kind: 'or', children: parts };
  }

  return parseOr();
}

function toDnf(node: Node): Atom[][] {
  if (node.kind === 'leaf') return [[node.atom]];
  if (node.kind === 'or') return node.children.flatMap(toDnf);
  let acc: Atom[][] = [[]];
  for (const child of node.children) {
    const childDnf = toDnf(child);
    const expanded: Atom[][] = [];
    for (const base of acc) for (const add of childDnf) expanded.push([...base, ...add]);
    acc = expanded;
  }
  return acc;
}

function clauseToCells(clause: Atom[], map: FieldMap): Record<string, string> {
  const byField = new Map<string, string[]>();
  for (const a of clause) {
    const list = byField.get(a.field) ?? [];
    list.push(a.cell);
    byField.set(a.field, list);
  }
  const cells: Record<string, string> = {};
  for (const [field, values] of byField) {
    cells[map[field]] = values.length > 1 ? values.join(' and ') : values[0];
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Scrape the Java file for staged rule markers + their if-conditions
// ---------------------------------------------------------------------------
interface ScrapedRule {
  stage: 's1' | 's2' | 's3';
  meta: string[];
  condition: string;
}

function extractRules(javaSrc: string): ScrapedRule[] {
  const lines = javaSrc.split(/\r?\n/);
  const rules: ScrapedRule[] = [];
  const marker = /^\s*\/\/\s*UW_RULE\s+(s[123])\s+(.+)$/;

  const captureCondition = (startIdx: number): { condition: string; endIdx: number } => {
    // Find the next line containing `if (` starting at/after startIdx (also matches `} else if (`).
    for (let j = startIdx; j < lines.length; j++) {
      const idx = lines[j].indexOf('if (');
      if (idx === -1) continue;
      const start = lines[j].indexOf('(', idx);
      let depth = 0;
      let cond = '';
      let k = start;
      for (; k < lines[j].length; k++) {
        const ch = lines[j][k];
        if (ch === '(') {
          depth++;
          if (depth === 1) continue;
        }
        if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
        cond += ch;
      }
      return { condition: cond.trim(), endIdx: j };
    }
    return { condition: '', endIdx: startIdx };
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(marker);
    if (!m) continue;
    const stage = m[1] as 's1' | 's2' | 's3';
    const meta = m[2].split('|').map((p) => p.trim());
    const { condition, endIdx } = captureCondition(i + 1);
    if (condition) rules.push({ stage, meta, condition });
    i = endIdx;
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Row builders per stage
// ---------------------------------------------------------------------------
function buildS1Rows(rules: ScrapedRule[]): any[] {
  const rows: any[] = [];
  for (const r of rules.filter((x) => x.stage === 's1')) {
    const [docCode, reason] = r.meta;
    for (const clause of toDnf(parseTokens(tokenize(r.condition), S1_MAP))) {
      const cells = clauseToCells(clause, S1_MAP);
      const row: any = { _id: `migrated-s1-${rows.length + 1}` };
      for (const colId of Object.values(S1_MAP)) row[colId] = cells[colId] ?? '';
      row['out-doc-code'] = `"${docCode}"`;
      row['out-doc-reason'] = `"${reason}"`;
      rows.push(row);
    }
  }
  return rows;
}

function buildS2Rows(rules: ScrapedRule[]): any[] {
  const rows: any[] = [];
  for (const r of rules.filter((x) => x.stage === 's2')) {
    const [ruleId, outcome, debits, exclusionCode, reason] = r.meta;
    for (const clause of toDnf(parseTokens(tokenize(r.condition), S2_MAP))) {
      const cells = clauseToCells(clause, S2_MAP);
      const row: any = { _id: `migrated-s2-${rows.length + 1}` };
      for (const colId of Object.values(S2_MAP)) row[colId] = cells[colId] ?? '';
      row['ra-out-id'] = `"${ruleId}"`;
      row['ra-out-type'] = `"${outcome}"`;
      row['ra-out-debits'] = debits;
      row['ra-out-excl'] = exclusionCode === '-' ? 'null' : `"${exclusionCode}"`;
      row['ra-out-reason'] = `"${reason}"`;
      rows.push(row);
    }
  }
  return rows;
}

function buildS3Rows(rules: ScrapedRule[]): any[] {
  const rows: any[] = [];
  for (const r of rules.filter((x) => x.stage === 's3')) {
    const [riskClass, table, decision, loading, refer] = r.meta;
    for (const clause of toDnf(parseTokens(tokenize(r.condition), S3_MAP))) {
      const cells = clauseToCells(clause, S3_MAP);
      const row: any = { _id: `migrated-s3-${rows.length + 1}` };
      for (const colId of Object.values(S3_MAP)) row[colId] = cells[colId] ?? '';
      row['rc-out-class'] = `"${riskClass}"`;
      row['rc-out-table'] = `"${table}"`;
      row['rc-out-decision'] = `"${decision}"`;
      row['rc-out-load'] = loading;
      row['rc-out-refer'] =
        refer === 'true' || refer === 'false' ? refer : `assessmentSummary.${refer}`;
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Structural graph template (validated against zen-engine 2.1.7 in Phase 0)
// ---------------------------------------------------------------------------
const FORMULAS_EXPRESSIONS = [
  { id: 'expr-bmi', key: 'derived.bmi', value: 'round(weightKg / (heightCm / 100 * (heightCm / 100)) * 10) / 10' },
  { id: 'expr-income-mult', key: 'derived.incomeMultiple', value: 'round(sumAssured / annualIncome * 10) / 10' },
];

const SUMMARY_EXPRESSIONS = [
  { id: 'sum-1', key: 'assessmentSummary.isSufficient', value: 'len(missingInfoMatches) == 0' },
  { id: 'sum-2', key: 'assessmentSummary.totalEmDebits', value: 'sum(map(assessmentMatches, #.debits))' },
  { id: 'sum-3', key: 'assessmentSummary.hasDeclineTrigger', value: 'some(assessmentMatches, #.outcome == "DECLINE")' },
  { id: 'sum-4', key: 'assessmentSummary.hasPostponeTrigger', value: 'some(assessmentMatches, #.outcome == "POSTPONE")' },
  { id: 'sum-5', key: 'assessmentSummary.hasExclusionTrigger', value: 'some(assessmentMatches, #.outcome == "EXCLUSION")' },
  { id: 'sum-6', key: 'assessmentSummary.hasComorbidityUncleanTrigger', value: 'some(assessmentMatches, #.outcome == "UNCLEAN_DEBIT")' },
];

const FORMATTER_SOURCE =
  'export const handler = async (input) => {\n' +
  '  const missingDocs = (input.missingInfoMatches || []).map(m => ({ docCode: m.missingDoc, reason: m.reason }));\n' +
  '  const assessments = input.assessmentMatches || [];\n' +
  '  const exclusions = assessments.filter(a => a.exclusionCode).map(a => a.exclusionCode);\n' +
  '  const cls = input.classificationResult || {};\n' +
  '  const summary = input.assessmentSummary || {};\n' +
  '  return {\n' +
  '    applicantId: input.applicantId,\n' +
  '    derivedMetrics: input.derived,\n' +
  '    step1SufficientInfo: {\n' +
  '      isSufficient: summary.isSufficient,\n' +
  '      missingDocuments: missingDocs\n' +
  '    },\n' +
  '    step2RiskAssessment: {\n' +
  '      totalEmDebits: summary.totalEmDebits,\n' +
  '      exclusionCodes: exclusions,\n' +
  '      hasDeclineTrigger: summary.hasDeclineTrigger,\n' +
  '      hasPostponeTrigger: summary.hasPostponeTrigger,\n' +
  '      hasComorbidityUncleanTrigger: summary.hasComorbidityUncleanTrigger,\n' +
  '      matchedAssessmentRules: assessments\n' +
  '    },\n' +
  '    step3RiskClassification: {\n' +
  '      riskClass: cls.riskClass,\n' +
  '      actuarialTableRating: cls.actuarialTableRating,\n' +
  '      loadingPct: cls.loadingPct\n' +
  '    },\n' +
  '    step4UnderwritingDecision: {\n' +
  '      finalDecision: cls.finalDecision,\n' +
  '      isUncleanReferral: cls.isUncleanReferral === true || cls.isUncleanReferral === \'true\',\n' +
  '      loadingPct: cls.loadingPct,\n' +
  '      exclusions: exclusions,\n' +
  '      requestedAdditionalInfo: missingDocs\n' +
  '    }\n' +
  '  };\n' +
  '};';

function buildJdm(s1Rows: any[], s2Rows: any[], s3Rows: any[]) {
  return {
    contentType: 'application/vnd.gorules.decision',
    nodes: [
      { id: 'node-input', name: '1. Proposal Form Input', type: 'inputNode', position: { x: 40, y: 240 } },
      {
        id: 'node-formulas',
        name: '0. Formulas (BMI & Financials)',
        type: 'expressionNode',
        position: { x: 280, y: 240 },
        content: { expressions: FORMULAS_EXPRESSIONS, passThrough: true },
      },
      {
        id: 'node-step1-info-check',
        name: '1.1 Sufficient Info & Evidence Check',
        type: 'decisionTableNode',
        position: { x: 560, y: 100 },
        content: {
          hitPolicy: 'collect',
          inputField: null,
          outputPath: 'missingInfoMatches',
          passThrough: true,
          inputs: [
            { id: 'inf-sa', name: 'Sum Assured', field: 'sumAssured' },
            { id: 'inf-age', name: 'Age', field: 'age' },
            { id: 'inf-bmi', name: 'Calculated BMI', field: 'derived.bmi' },
            { id: 'inf-med', name: "Medical Conditions", field: 'medicalConditions' },
            { id: 'inf-docs', name: 'Submitted Docs', field: 'submittedDocuments' },
          ],
          outputs: [
            { id: 'out-doc-code', name: 'Missing Doc Code', field: 'missingDoc' },
            { id: 'out-doc-reason', name: 'Reason', field: 'reason' },
          ],
          rules: s1Rows,
        },
      },
      {
        id: 'node-step2-risk-assessment',
        name: '2. Risk Assessment (Debits & Flags)',
        type: 'decisionTableNode',
        position: { x: 560, y: 360 },
        content: {
          hitPolicy: 'collect',
          inputField: null,
          outputPath: 'assessmentMatches',
          passThrough: true,
          inputs: [
            { id: 'ra-age', name: 'Age', field: 'age' },
            { id: 'ra-bmi', name: 'Calculated BMI', field: 'derived.bmi' },
            { id: 'ra-bp', name: 'Systolic BP', field: 'systolicBp' },
            { id: 'ra-smoker', name: 'Smoker', field: 'smoker' },
            { id: 'ra-inc-mult', name: 'Income Multiple', field: 'derived.incomeMultiple' },
            { id: 'ra-surg', name: 'Surgery Months Ago', field: 'recentSurgeryMonthsAgo' },
            { id: 'ra-med', name: 'Medical Conditions', field: 'medicalConditions' },
            { id: 'ra-occ', name: 'Occupation Class', field: 'occupationClass' },
            { id: 'ra-avoc', name: 'Avocations', field: 'avocations' },
          ],
          outputs: [
            { id: 'ra-out-id', name: 'Rule ID', field: 'ruleId' },
            { id: 'ra-out-type', name: 'Assessment Outcome', field: 'outcome' },
            { id: 'ra-out-debits', name: 'EM Debits', field: 'debits' },
            { id: 'ra-out-excl', name: 'Exclusion Code', field: 'exclusionCode' },
            { id: 'ra-out-reason', name: 'Reason', field: 'reason' },
          ],
          rules: s2Rows,
        },
      },
      {
        id: 'node-step2-summary',
        name: '2.5 Assessment Summary Formulas',
        type: 'expressionNode',
        position: { x: 860, y: 240 },
        content: { expressions: SUMMARY_EXPRESSIONS, passThrough: true },
      },
      {
        id: 'node-step3-classification',
        name: '3. Risk Classification & 4. Decision Matrix',
        type: 'decisionTableNode',
        position: { x: 1140, y: 240 },
        content: {
          hitPolicy: 'first',
          inputField: null,
          outputPath: 'classificationResult',
          passThrough: true,
          inputs: [
            { id: 'rc-suff', name: 'Sufficient Info?', field: 'assessmentSummary.isSufficient' },
            { id: 'rc-dec', name: 'Has Decline?', field: 'assessmentSummary.hasDeclineTrigger' },
            { id: 'rc-post', name: 'Has Postpone?', field: 'assessmentSummary.hasPostponeTrigger' },
            { id: 'rc-excl', name: 'Has Exclusion?', field: 'assessmentSummary.hasExclusionTrigger' },
            { id: 'rc-debits', name: 'Total EM Debits', field: 'assessmentSummary.totalEmDebits' },
            { id: 'rc-unclean', name: 'Comorbidity Flag?', field: 'assessmentSummary.hasComorbidityUncleanTrigger' },
          ],
          outputs: [
            { id: 'rc-out-class', name: '3. Risk Class', field: 'riskClass' },
            { id: 'rc-out-table', name: 'Actuarial Rating', field: 'actuarialTableRating' },
            { id: 'rc-out-decision', name: '4. Final Decision', field: 'finalDecision' },
            { id: 'rc-out-load', name: 'Loading %', field: 'loadingPct' },
            { id: 'rc-out-refer', name: 'Is Unclean Referral?', field: 'isUncleanReferral' },
          ],
          rules: s3Rows,
        },
      },
      {
        id: 'node-step4-formatter',
        name: '4. Final Underwriting Output Envelope',
        type: 'functionNode',
        position: { x: 1420, y: 240 },
        content: { source: FORMATTER_SOURCE },
      },
      { id: 'node-output', name: 'Underwriting Response', type: 'outputNode', position: { x: 1680, y: 240 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'node-input', targetId: 'node-formulas' },
      { id: 'e2', sourceId: 'node-formulas', targetId: 'node-step1-info-check' },
      { id: 'e3', sourceId: 'node-formulas', targetId: 'node-step2-risk-assessment' },
      { id: 'e4', sourceId: 'node-step1-info-check', targetId: 'node-step2-summary' },
      { id: 'e5', sourceId: 'node-step2-risk-assessment', targetId: 'node-step2-summary' },
      { id: 'e6', sourceId: 'node-step2-summary', targetId: 'node-step3-classification' },
      { id: 'e7', sourceId: 'node-step3-classification', targetId: 'node-step4-formatter' },
      { id: 'e8', sourceId: 'node-step4-formatter', targetId: 'node-output' },
    ],
  };
}

function emitLlmPrompt(javaSrc: string) {
  const schema = {
    name: 'jdm_decision_graph',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        contentType: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
        edges: { type: 'array', items: { type: 'object' } },
      },
      required: ['contentType', 'nodes', 'edges'],
    },
  };
  console.log('===== LLM-Assisted Migration Prompt (Java -> 4-Stage GoRules JDM) =====\n');
  console.log(
    [
      'You are a rules modernization engine.',
      'Convert the following LEGACY Java underwriting service into a valid GoRules JDM decision graph.',
      'Requirements:',
      '  - Emit the four-stage graph: inputNode -> expressionNode (derived.bmi / derived.incomeMultiple)',
      '    -> collect decisionTable (1.1 sufficiency) + collect decisionTable (2. risk assessment)',
      '    -> expressionNode (2.5 summary: len/some/map/sum over #.) -> first decisionTable (3./4. classification)',
      '    -> functionNode (output envelope, content: { source }) -> outputNode.',
      '  - Scrape the `// UW_RULE s1|s2|s3 ...` markers for rule metadata; convert each if-condition',
      '    into decision-table cells (DNF: OR across fields becomes one row per branch).',
      '  - Preserve ruleId / outcome / debits / exclusionCode / reason / riskClass / finalDecision exactly.',
      '  - Return ONLY JSON matching the provided schema.',
      '',
      'OUTPUT JSON SCHEMA:',
      JSON.stringify(schema, null, 2),
      '',
      'LEGACY JAVA SOURCE:',
      '```java',
      javaSrc,
      '```',
    ].join('\n'),
  );
}

function main() {
  if (!fs.existsSync(JAVA_FILE)) {
    console.error(`Cannot find legacy Java source at: ${JAVA_FILE}`);
    process.exit(1);
  }
  const javaSrc = fs.readFileSync(JAVA_FILE, 'utf-8');
  if (process.argv.includes('--llm-prompt')) {
    emitLlmPrompt(javaSrc);
    return;
  }

  const rules = extractRules(javaSrc);
  if (rules.length === 0) {
    console.error('No UW_RULE markers found in the legacy Java source.');
    process.exit(1);
  }
  const s1Rows = buildS1Rows(rules);
  const s2Rows = buildS2Rows(rules);
  const s3Rows = buildS3Rows(rules);
  const jdm = buildJdm(s1Rows, s2Rows, s3Rows);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(jdm, null, 2) + '\n', 'utf-8');

  console.log('astToJdmMigrator (deterministic mode, PRD v2 four-stage graph)');
  console.log('--------------------------------------------------------------');
  console.log(`Scraped ${rules.length} legacy rule blocks from HardcodedUnderwritingService.java`);
  console.log(`  stage 1 (info sufficiency):  ${s1Rows.length} rows`);
  console.log(`  stage 2 (risk assessment):   ${s2Rows.length} rows`);
  console.log(`  stage 3 (classification):    ${s3Rows.length} rows`);
  console.log(`Wrote JDM graph -> ${path.relative(process.cwd(), OUT_FILE)}`);
  for (const r of rules) {
    console.log(`  - [${r.stage}] ${r.meta[0]} <= ${r.condition}`);
  }
}

main();
