#!/usr/bin/env node
/**
 * @sdd-managed: Pre-Tool / Pre-Edit Guardrail
 * Enforces Benchmark 3.1 (Forbidden paths, active spec requirement) & 4.1 (TDD Judge Lock)
 */
import fs from 'node:fs';
import path from 'node:path';

const lockPath = path.resolve(process.cwd(), '.sdd/spec-lock.json');
const configPath = path.resolve(process.cwd(), 'sdd.config.yaml');

// Read tool input from stdin (Claude Code / Agent JSON hook protocol) or CLI args
let payload = {};
try {
  const stdin = fs.readFileSync(0, 'utf-8').trim();
  if (stdin) payload = JSON.parse(stdin);
} catch {
  // Fallback for CLI args invocation: node pre-tool-guard.mjs --file <path>
}

const targetFile =
  payload?.tool_input?.file_path ||
  payload?.tool_input?.path ||
  process.argv[2] ||
  '';

if (!targetFile || !fs.existsSync(lockPath)) process.exit(0);

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
const relPath = path.relative(process.cwd(), path.resolve(process.cwd(), targetFile)).replace(/\\/g, '/');

// Allow edits to SDD governance files during /refine or /refresh
if (relPath.startsWith('.sdd/') || relPath === 'sdd.config.yaml' || relPath.startsWith('.specs/')) {
  process.exit(0);
}

// Graceful Bootstrap Probe: If project hasn't run /refine yet, warn instead of blocking
if (lock.bootstrapStage === 'scaffolded') {
  console.error(`⚠️ [SDD PROBE WARNING]: Project is in 'scaffolded' stage. Run '/refine' to activate strict TDD & Spec guardrails.`);
  process.exit(0);
}

const isTestOrSchema = /\.(spec|test)\.[jt]sx?$|^test_.*\.py$|\.(schema|interface)\.[jt]s$|openapi\.ya?ml$/.test(relPath);

// Benchmark 4.1.2: Lock Test & Schema files during 'impl-green' phase (Anti-Reward-Hacking)
if (lock.activePhase === 'impl-green' && isTestOrSchema) {
  console.error(`❌ [SDD GUARDRAIL 4.1.2 - JUDGE LOCKED]: Modifying test or schema file '${relPath}' is FORBIDDEN during the 'impl-green' phase. Fix the implementation code to satisfy the existing test/contract, or switch phase via 'npx sdd phase test-red'.`);
  process.exit(2);
}

// Benchmark 4.1.1: Block implementation code edits during 'test-red' phase
if (lock.activePhase === 'test-red' && !isTestOrSchema) {
  console.error(`❌ [SDD GUARDRAIL 4.1.1 - RED PHASE ISOLATION]: Cannot modify implementation file '${relPath}' during 'test-red' phase. Write failing tests/schemas first, then run 'npx sdd phase impl-green'.`);
  process.exit(2);
}

process.exit(0);
