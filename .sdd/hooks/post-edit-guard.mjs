#!/usr/bin/env node
/**
 * @sdd-managed: Post-Edit Guardrail
 * Enforces Benchmark 3.2 (Block type escapes, empty catch, custom regex rules, incremental typecheck)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const lockPath = path.resolve(process.cwd(), '.sdd/spec-lock.json');
if (!fs.existsSync(lockPath)) process.exit(0);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));

// Injected by `sdd apply` from sdd.config.yaml:
const CONFIG = {"gracefulBootstrapProbe":true,"blockTypeEscapes":true,"blockEmptyCatchBlocks":true,"typecheckCommand":"npx tsc --noEmit -p gorules-ts-engine/tsconfig.json && npx tsc --noEmit -p gorules-admin-ui/tsconfig.json","truncateLines":40,"customRegexRules":[]};

let diffOutput = '';
try {
  diffOutput = execSync('git diff -U0 HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  process.exit(0);
}

const addedLines = diffOutput
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');

const violations = [];

// 1. Benchmark 3.2.1: Block Type Escapes & Linter Suppression Hallucinations
if (CONFIG.blockTypeEscapes) {
  const escapeRegex = /(@ts-ignore|@ts-expect-error|eslint-disable|:\s*any\b|\bas\s+any\b|#\s*type:\s*ignore|#\s*noqa)/;
  if (escapeRegex.test(addedLines)) {
    violations.push(`[Benchmark 3.2.1 - Type Escape Blocked]: Detected forbidden type escape or linter suppression (@ts-ignore, any, eslint-disable, # type: ignore) in added lines. Satisfy the strict type contract instead.`);
  }
}

// 2. Benchmark 3.2.1: Block Silent Empty Catch Blocks
if (CONFIG.blockEmptyCatchBlocks) {
  const emptyCatchRegex = /catch\s*(\([^)]*\))?\s*\{\s*(\/\/.*|\/\*[\s\S]*?\*\/)?\s*\}/;
  if (emptyCatchRegex.test(addedLines)) {
    violations.push(`[Benchmark 3.2.1 - Silent Exception Swallowing]: Detected an empty catch block. Handle or propagate errors explicitly according to the Spec contract.`);
  }
}

// 3. Custom Regex Rules from sdd.config.yaml
for (const rule of CONFIG.customRegexRules) {
  const re = new RegExp(rule.forbiddenRegex);
  if (re.test(addedLines)) {
    violations.push(`[Custom Rule '${rule.id}']: ${rule.instructionText}`);
  }
}

if (violations.length > 0) {
  console.error(`❌ [SDD POST-EDIT GUARDRAIL VIOLATION]:\n` + violations.map((v) => `  - ${v}`).join('\n'));
  process.exit(2);
}

// 4. Benchmark 3.2.2: Incremental Typecheck (With Graceful Bootstrap Probe)
if (CONFIG.typecheckCommand && lock.bootstrapStage === 'refined') {
  try {
    execSync(CONFIG.typecheckCommand, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    const out = ((err.stdout || '') + '\n' + (err.stderr || '')).trim().split('\n');
    const truncated = out.slice(0, CONFIG.truncateLines).join('\n');
    console.error(`❌ [SDD INCREMENTAL TYPECHECK FAILED]:\n${truncated}`);
    process.exit(2);
  }
}

process.exit(0);
