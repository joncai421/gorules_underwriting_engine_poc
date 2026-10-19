import fs from 'node:fs';
import path from 'node:path';
import { ZenEngine, type ZenDecision } from '@gorules/zen-engine';
import type { ApplicantRequest, UnderwritingCoreResult } from '../types';

// shared/ lives at the repository root, two levels above this package's src/.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const RULES_DIR = path.join(REPO_ROOT, 'shared', 'rules');

export interface RuleSummary {
  id: string;
  fileName: string;
  ruleCount: number;
}

export interface EvaluateOutcome {
  result: UnderwritingCoreResult;
  trace: unknown;
  executionTimeMs: number;
  activeRuleId: string;
}

/**
 * Thin wrapper around the GoRules `ZenEngine`.
 *
 * Responsibilities:
 *  - Discover JDM rule files under shared/rules and compile them lazily.
 *  - Track the "active" rule version used for evaluation.
 *  - Hot-reload a rule when it is saved/updated from the Admin UI.
 *  - Expose execution traces for the AI copilot and the editor simulator.
 */
export class UwEngine {
  private engine: ZenEngine;
  private decisions = new Map<string, ZenDecision>();
  private activeId: string;

  constructor() {
    this.engine = new ZenEngine();
    const ids = UwEngine.discoverRuleIds();
    if (ids.length === 0) {
      throw new Error(`No JDM rule files found in ${RULES_DIR}`);
    }
    // Default active version: the migrated v1 rules.
    this.activeId = ids.includes('v1-migrated-rules') ? 'v1-migrated-rules' : ids[0];
  }

  /** Rule ids are the JSON file base names (without extension). */
  static discoverRuleIds(): string[] {
    if (!fs.existsSync(RULES_DIR)) return [];
    return fs
      .readdirSync(RULES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/i, ''))
      .sort();
  }

  static filePathFor(id: string): string {
    return path.join(RULES_DIR, `${id}.json`);
  }

  private compile(id: string): ZenDecision {
    const file = UwEngine.filePathFor(id);
    const content = fs.readFileSync(file);
    const decision = this.engine.createDecision(content);
    this.decisions.set(id, decision);
    return decision;
  }

  private getDecision(id: string): ZenDecision {
    return this.decisions.get(id) ?? this.compile(id);
  }

  listRules(): RuleSummary[] {
    return UwEngine.discoverRuleIds().map((id) => ({
      id,
      fileName: `${id}.json`,
      ruleCount: this.readRaw(id).nodes.find((n: any) => n.type === 'decisionTableNode')?.content?.rules?.length ?? 0,
    }));
  }

  getActiveId(): string {
    return this.activeId;
  }

  setActive(id: string): void {
    if (!UwEngine.discoverRuleIds().includes(id)) {
      throw new Error(`Unknown rule id: ${id}`);
    }
    this.getDecision(id); // ensure it compiles before switching
    this.activeId = id;
  }

  /** Read raw JDM JSON for a given rule id (for the Admin UI editor). */
  readRaw(id: string): any {
    const file = UwEngine.filePathFor(id);
    if (!fs.existsSync(file)) throw new Error(`Rule file not found: ${id}`);
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }

  /** Persist updated JDM JSON to disk and hot-reload the compiled decision. */
  saveRule(id: string, jdm: unknown): RuleSummary {
    const file = UwEngine.filePathFor(id);
    fs.writeFileSync(file, JSON.stringify(jdm, null, 2) + '\n', 'utf-8');
    this.decisions.delete(id);
    this.compile(id);
    return {
      id,
      fileName: `${id}.json`,
      ruleCount: (jdm as any).nodes.find((n: any) => n.type === 'decisionTableNode')?.content?.rules?.length ?? 0,
    };
  }

  /** Create a brand-new rule version by cloning an existing one and appending rows. */
  onboard(
    sourceId: string,
    newId: string,
    extraRows: unknown[],
  ): { id: string; ruleCount: number } {
    const base = this.readRaw(sourceId);
    const table = base.nodes.find((n: any) => n.type === 'decisionTableNode');
    if (!table) throw new Error(`Source rule ${sourceId} has no decision table node`);
    table.content.rules = [...(table.content.rules ?? []), ...extraRows];
    const summary = this.saveRule(newId, base);
    return { id: summary.id, ruleCount: summary.ruleCount };
  }

  /**
   * Evaluate an applicant against the given (or active) rule version.
   * `trace: true` makes the engine return per-node execution traces, which power
   * both the Admin UI simulator highlighting and the AI copilot context extraction.
   */
  async evaluate(payload: ApplicantRequest, ruleId?: string): Promise<EvaluateOutcome> {
    const id = ruleId ?? this.activeId;
    const decision = this.getDecision(id);
    const start = process.hrtime.bigint();
    const response = await decision.evaluate(payload, { trace: true });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    const result = response.result as UnderwritingCoreResult;
    return {
      result: {
        decision: result.decision,
        basePremiumLoadingPct: result.basePremiumLoadingPct,
        triggeredRules: result.triggeredRules ?? [],
      },
      trace: response.trace ?? null,
      executionTimeMs: Number(elapsedMs.toFixed(3)),
      activeRuleId: id,
    };
  }
}

// Process-wide singleton used by the HTTP server.
let singleton: UwEngine | null = null;
export function getEngine(): UwEngine {
  if (!singleton) singleton = new UwEngine();
  return singleton;
}
