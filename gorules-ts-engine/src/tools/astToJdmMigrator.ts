import fs from 'node:fs';
import path from 'node:path';

/**
 * astToJdmMigrator.ts  (`npm run migrate`)
 *
 * Deterministic, zero-API-key migration helper that reads the LEGACY Java source
 * (HardcodedUnderwritingService.java) and rebuilds a valid GoRules JDM decision-table
 * graph at shared/rules/v1-migrated-rules.json.
 *
 * Dual-mode extractor (PRD Requirement 3a):
 *   - Default: regex scrape of `// UW_RULE <id> | <category> | <decision> | <loading> | <reason>`
 *     markers + a recursive-descent parse of the following `if (...)` boolean condition.
 *     The condition is normalized to DNF so OR-across-fields (e.g. the composite
 *     RULE_HIGH_SUM_ASSURED) becomes one decision-table row per branch.
 *   - `--llm-prompt`: instead of writing JSON, emits a structured prompt + JSON Schema that
 *     demonstrates how an LLM would perform the same Java -> JDM conversion.
 */

const JAVA_FILE = path.resolve(__dirname, '..', '..', '..', 'legacy-java-service', 'src', 'main', 'java', 'com', 'poc', 'uw', 'service', 'HardcodedUnderwritingService.java');
const OUT_FILE = path.resolve(__dirname, '..', '..', '..', 'shared', 'rules', 'v1-migrated-rules.json');

// Java field name -> JDM decision-table input column id.
const FIELD_TO_COL: Record<string, string> = {
  age: 'in-age',
  bmi: 'in-bmi',
  systolicBp: 'in-bp',
  smoker: 'in-smoker',
  sumAssured: 'in-sa',
  medicalConditions: 'in-med',
  occupationClass: 'in-occ',
};

interface Atom {
  field: string;
  cell: string;
}
type Node =
  | { kind: 'leaf'; atom: Atom }
  | { kind: 'or'; children: Node[] }
  | { kind: 'and'; children: Node[] };

interface RuleMeta {
  ruleId: string;
  category: string;
  decision: string;
  loading: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Tokenizer (structural tokens only; operands are captured as atomic spans)
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
    // Track parentheses that belong to a method call (e.g. contains("X")) so they are
    // treated as part of the operand, not logical grouping.
    if (src[i] === '(' && /\w$/.test(buf)) {
      buf += src[i];
      i++;
      // consume until matching ')'
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

function atomFromSpan(span: string, negate = false): Atom | null {
  let s = span.trim();

  // medicalConditions.contains("X")
  const contains = s.match(/^(\w+)\.contains\(\s*"([^"]+)"\s*\)$/);
  if (contains && FIELD_TO_COL[contains[1]]) {
    return { field: contains[1], cell: `contains($, "${contains[2]}")` };
  }

  // field OP value
  const cmp = s.match(/^(\w+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (cmp) {
    const [, field, op, rawVal] = cmp;
    const val = rawVal.trim();
    if (!FIELD_TO_COL[field]) return null;
    if (op === '==' || op === '!=') {
      if (val === 'true') return { field, cell: op === '==' ? 'true' : 'false' };
      if (val === 'false') return { field, cell: op === '==' ? 'false' : 'true' };
      if (/^".*"$/.test(val)) return { field, cell: `${op === '!=' ? 'not ' : ''}${val}` };
      return { field, cell: `${op} ${stripNumber(val)}` };
    }
    if (/^-?\d+(\.\d+)?$/.test(val)) {
      const num = stripNumber(val);
      if (negate) {
        const flip = { '>': '<=', '<': '>=', '>=': '<', '<=': '>' } as Record<string, string>;
        return { field, cell: `${flip[op]} ${num}` };
      }
      return { field, cell: `${op} ${num}` };
    }
    return { field, cell: `${op} ${val}` };
  }

  // bare boolean identifier (possibly negated upstream)
  if (/^\w+$/.test(s) && FIELD_TO_COL[s]) {
    if (negate) return { field: s, cell: 'false' };
    return { field: s, cell: 'true' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser -> AST
// ---------------------------------------------------------------------------
function parseTokens(toks: Token[]): Node {
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
      // Only handle ! applied to a bare boolean identifier (e.g. !smoker).
      const operand = peek();
      if (operand && operand.t === 'atom' && /^\w+$/.test(operand.v) && FIELD_TO_COL[operand.v]) {
        next();
        return { kind: 'leaf', atom: { field: operand.v, cell: 'false' } };
      }
      return parsePrimary();
    }
    if (t && t.t === 'atom') {
      next();
      const atom = atomFromSpan(t.v);
      return atom ? { kind: 'leaf', atom } : { kind: 'and', children: [] };
    }
    next();
    return { kind: 'and', children: [] };
  }

  function parseAnd(): Node {
    let left = parsePrimary();
    const parts: Node[] = [left];
    while (peek() && peek().t === '&&') {
      next();
      parts.push(parsePrimary());
    }
    if (parts.length === 1) return parts[0];
    return { kind: 'and', children: parts };
  }

  function parseOr(): Node {
    let left = parseAnd();
    const parts: Node[] = [left];
    while (peek() && peek().t === '||') {
      next();
      parts.push(parseAnd());
    }
    if (parts.length === 1) return parts[0];
    return { kind: 'or', children: parts };
  }

  return parseOr();
}

// AST -> DNF: array of clauses, each clause = array of atoms (a conjunction).
function toDnf(node: Node): Atom[][] {
  if (node.kind === 'leaf') return [[node.atom]];
  if (node.kind === 'or') {
    return node.children.flatMap(toDnf);
  }
  // and: cartesian product of children DNFs
  let acc: Atom[][] = [[]];
  for (const child of node.children) {
    const childDnf = toDnf(child);
    const next: Atom[][] = [];
    for (const base of acc) {
      for (const add of childDnf) {
        next.push([...base, ...add]);
      }
    }
    acc = next;
  }
  return acc;
}

function clauseToCells(clause: Atom[]): Record<string, string> {
  const byField = new Map<string, string[]>();
  for (const a of clause) {
    const list = byField.get(a.field) ?? [];
    list.push(a.cell);
    byField.set(a.field, list);
  }
  const cells: Record<string, string> = {};
  for (const [field, values] of byField) {
    cells[FIELD_TO_COL[field]] = values.length > 1 ? values.join(' and ') : values[0];
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Scrape the Java file for rules
// ---------------------------------------------------------------------------
function extractRules(javaSrc: string): { meta: RuleMeta; condition: string }[] {
  const lines = javaSrc.split(/\r?\n/);
  const rules: { meta: RuleMeta; condition: string }[] = [];
  const marker = /^\s*\/\/\s*UW_RULE\s+(.+?)\s*\|\s+(.+?)\s*\|\s+(.+?)\s*\|\s+(\d+)\s*\|\s+(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(marker);
    if (!m) continue;
    const meta: RuleMeta = {
      ruleId: m[1],
      category: m[2],
      decision: m[3],
      loading: Number(m[4]),
      reason: m[5],
    };
    // Find the next `if (...)` after the marker and capture its condition.
    for (let j = i + 1; j < lines.length; j++) {
      const idx = lines[j].indexOf('if (');
      if (idx !== -1) {
        const start = lines[j].indexOf('(', idx);
        let depth = 0;
        let cond = '';
        for (let k = start; k < lines[j].length; k++) {
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
        rules.push({ meta, condition: cond.trim() });
        i = j; // continue scanning after this if-line
        break;
      }
    }
  }
  return rules;
}

function buildJdm(rules: { meta: RuleMeta; condition: string }[]) {
  const tableRules: any[] = [];
  let rowIdx = 0;
  for (const r of rules) {
    const dnf = toDnf(parseTokens(tokenize(r.condition)));
    for (const clause of dnf) {
      rowIdx++;
      const cells = clauseToCells(clause);
      const row: any = { _id: `migrated-${rowIdx}` };
      for (const colId of Object.values(FIELD_TO_COL)) {
        row[colId] = cells[colId] ?? '';
      }
      row['out-dec'] = `"${r.meta.decision}"`;
      row['out-id'] = `"${r.meta.ruleId}"`;
      row['out-cat'] = `"${r.meta.category}"`;
      row['out-load'] = String(r.meta.loading);
      row['out-reason'] = `"${r.meta.reason}"`;
      tableRules.push(row);
    }
  }

  const aggregatorSource =
    'export const handler = async (input) => {\n' +
    '  const raw = Array.isArray(input) ? input : (input && Array.isArray(input.matches)) ? input.matches : (input ? [input] : []);\n' +
    '  const matches = raw.filter(m => m && m.ruleId);\n' +
    '  const uniqueRules = new Map();\n' +
    '  for (const m of matches) {\n' +
    '    if (!uniqueRules.has(m.ruleId)) uniqueRules.set(m.ruleId, m);\n' +
    '  }\n' +
    '  const rules = Array.from(uniqueRules.values());\n' +
    "  const hasDecline = rules.some(r => r.ruleDecision === 'DECLINE');\n" +
    "  const hasUnclean = rules.some(r => r.ruleDecision === 'UNCLEAN');\n" +
    "  let decision = 'CLEAN';\n" +
    "  if (hasDecline) decision = 'DECLINE';\n" +
    "  else if (hasUnclean) decision = 'UNCLEAN';\n" +
    "  const basePremiumLoadingPct = decision === 'DECLINE' ? 0 : rules.reduce((acc, r) => acc + (Number(r.loadingPct) || 0), 0);\n" +
    '  const triggeredRules = rules.length > 0\n' +
    '    ? rules.map(r => ({ ruleId: r.ruleId, category: r.category, reason: r.reason }))\n' +
    "    : [{ ruleId: 'RULE_STANDARD_CLEAN', category: 'STANDARD', reason: 'Standard clean acceptance' }];\n" +
    '  return { decision, basePremiumLoadingPct, triggeredRules };\n' +
    '};';

  return {
    contentType: 'application/vnd.gorules.decision',
    nodes: [
      { id: 'node-input', name: 'Applicant Input', type: 'inputNode', position: { x: 60, y: 200 } },
      {
        id: 'node-uw-table',
        name: 'Underwriting Decision Table',
        type: 'decisionTableNode',
        position: { x: 320, y: 200 },
        content: {
          hitPolicy: 'collect',
          inputs: [
            { id: 'in-age', name: 'Age', field: 'age' },
            { id: 'in-bmi', name: 'BMI', field: 'bmi' },
            { id: 'in-bp', name: 'Systolic BP', field: 'systolicBp' },
            { id: 'in-smoker', name: 'Smoker', field: 'smoker' },
            { id: 'in-sa', name: 'Sum Assured', field: 'sumAssured' },
            { id: 'in-med', name: 'Medical Conditions', field: 'medicalConditions' },
            { id: 'in-occ', name: 'Occupation Class', field: 'occupationClass' },
          ],
          outputs: [
            { id: 'out-dec', name: 'Decision', field: 'ruleDecision' },
            { id: 'out-id', name: 'Rule ID', field: 'ruleId' },
            { id: 'out-cat', name: 'Category', field: 'category' },
            { id: 'out-load', name: 'Loading %', field: 'loadingPct' },
            { id: 'out-reason', name: 'Reason', field: 'reason' },
          ],
          rules: tableRules,
        },
      },
      {
        id: 'node-aggregator',
        name: 'Decision Aggregator',
        type: 'functionNode',
        position: { x: 620, y: 200 },
        content: { source: aggregatorSource },
      },
      { id: 'node-output', name: 'Final Response', type: 'outputNode', position: { x: 900, y: 200 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'node-input', targetId: 'node-uw-table' },
      { id: 'e2', sourceId: 'node-uw-table', targetId: 'node-aggregator' },
      { id: 'e3', sourceId: 'node-aggregator', targetId: 'node-output' },
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
  console.log('===== LLM-Assisted Migration Prompt (Java -> GoRules JDM) =====\n');
  console.log(
    [
      'You are a rules modernization engine.',
      'Convert the following LEGACY Java underwriting service into a valid GoRules JDM decision graph.',
      'Requirements:',
      '  - Emit an inputNode -> decisionTableNode (hitPolicy "collect") -> functionNode (aggregator) -> outputNode graph.',
      '  - Map each hardcoded if-condition to decision-table rows keyed by input column ids.',
      '  - Preserve ruleId / category / reason / loadingPct metadata exactly.',
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
  const isLlm = process.argv.includes('--llm-prompt');

  if (isLlm) {
    emitLlmPrompt(javaSrc);
    return;
  }

  const rules = extractRules(javaSrc);
  if (rules.length === 0) {
    console.error('No UW_RULE markers found in the legacy Java source.');
    process.exit(1);
  }
  const jdm = buildJdm(rules);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(jdm, null, 2) + '\n', 'utf-8');

  console.log('astToJdmMigrator (deterministic mode)');
  console.log('--------------------------------------');
  console.log(`Scraped ${rules.length} legacy rule blocks from HardcodedUnderwritingService.java`);
  console.log(`Expanded into ${(jdm as any).nodes[1].content.rules.length} decision-table rows (DNF)`);
  console.log(`Wrote JDM graph -> ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log('');
  for (const r of rules) {
    console.log(`  - ${r.meta.ruleId} [${r.meta.decision}/${r.meta.loading}%] <= ${r.condition}`);
  }
}

main();
