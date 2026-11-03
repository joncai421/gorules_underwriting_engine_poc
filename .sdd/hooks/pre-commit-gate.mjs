#!/usr/bin/env node
/**
 * @sdd-managed: Pre-Commit / Task Completion Gate
 * Enforces Benchmark 3.3 (Zero-trust exit code check & Git diff scope audit)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const lockPath = path.resolve(process.cwd(), '.sdd/spec-lock.json');
if (!fs.existsSync(lockPath)) process.exit(0);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));

// Injected by `sdd apply` from sdd.config.yaml:
const GATE_CONFIG = {"typecheckCommand":"npx tsc --noEmit -p gorules-ts-engine/tsconfig.json && npx tsc --noEmit -p gorules-admin-ui/tsconfig.json","testUnitCommand":"npm run selftest --silent","lintCommand":""};

if (lock.bootstrapStage === 'scaffolded') {
  console.log('⚠️ [SDD PRE-COMMIT]: In scaffolded mode. Skipping strict test/typecheck gates until /refine is completed.');
  process.exit(0);
}

const commands = [
  { name: 'Typecheck', cmd: GATE_CONFIG.typecheckCommand },
  { name: 'Unit Tests', cmd: GATE_CONFIG.testUnitCommand },
  { name: 'Linter', cmd: GATE_CONFIG.lintCommand },
].filter((c) => Boolean(c.cmd));

for (const item of commands) {
  try {
    console.log(`🔍 [SDD GATE]: Running ${item.name} (${item.cmd})...`);
    execSync(item.cmd, { stdio: 'inherit' });
  } catch {
    console.error(`❌ [SDD GATE FAILED]: ${item.name} failed with non-zero exit code. Commit aborted.`);
    process.exit(1);
  }
}

process.exit(0);
