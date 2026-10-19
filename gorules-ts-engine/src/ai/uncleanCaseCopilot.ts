import type { AiCopilotBrief, ApplicantRequest, TriggeredRule } from '../types';

/**
 * Snapshot of what actually fired inside the GoRules graph, extracted from the raw
 * execution trace. Used as grounding context for the copilot brief so the narrative
 * is anchored to the concrete matched rows rather than a generic template.
 */
export interface TraceSnapshot {
  matchedRuleIds: string[];
  matchedRows: Record<string, unknown>[];
  inputSnapshot: Record<string, unknown>;
}

/**
 * Parses the zen-engine trace object (`Record<nodeId, ZenEngineTrace>`) to recover the
 * exact decision-table rows and input field snapshots that produced the UNCLEAN referral.
 *
 * The decision table node emits its matched rows as an array under `output`; we scan all
 * traced nodes for such arrays whose elements carry a `ruleId`, which keeps this resilient
 * to node-id changes or the editor wiring a different aggregator table.
 */
export function extractMatchedNodesFromTrace(trace: unknown): TraceSnapshot {
  const snapshot: TraceSnapshot = { matchedRuleIds: [], matchedRows: [], inputSnapshot: {} };
  if (!trace || typeof trace !== 'object') return snapshot;

  for (const nodeTrace of Object.values(trace as Record<string, any>)) {
    const output = nodeTrace?.output;
    const rows = Array.isArray(output) ? output : output ? [output] : [];
    const ruleRows = rows.filter((r: any) => r && typeof r === 'object' && typeof r.ruleId === 'string');
    if (ruleRows.length > 0) {
      for (const row of ruleRows) {
        if (!snapshot.matchedRuleIds.includes(row.ruleId)) {
          snapshot.matchedRuleIds.push(row.ruleId);
          snapshot.matchedRows.push(row);
        }
      }
    }
    // The input node carries the original request field snapshot.
    if (nodeTrace?.input && typeof nodeTrace.input === 'object' && !snapshot.inputSnapshot.applicantId) {
      snapshot.inputSnapshot = nodeTrace.input;
    }
  }
  return snapshot;
}

// Mini embedded medical underwriting manual, keyed by rule id, used by the deterministic
// generator and injected as reference knowledge into the live LLM prompt.
const GUIDELINE_LIBRARY: Record<string, { evidence: string[]; manual: string }> = {
  RULE_BMI_COMORBIDITY: {
    evidence: ['Liver ultrasound within 6 months', 'HbA1c lab report', 'Fasting lipid profile'],
    manual: 'Reinsurance Medical Manual Sec 4.2 - Metabolic Syndrome',
  },
  RULE_BP_SMOKER_SYNERGY: {
    evidence: ['Resting ECG', 'Repeat ambulatory BP monitoring (7-day)', 'Cardiac risk score (SCORE2)'],
    manual: 'Reinsurance Medical Manual Sec 3.7 - Cardiovascular Risk in Smokers',
  },
  RULE_HIGH_SUM_ASSURED: {
    evidence: ['Financial net-worth statement', 'Source-of-wealth documentation', 'Senior underwriter sign-off memo'],
    manual: 'Financial Underwriting Manual Sec 2.1 - Non-Medical Limits & Sum Assured',
  },
  RULE_HIGH_RISK_OCCUPATION: {
    evidence: ['Occupational questionnaire (Class 4)', 'Hazard exposure declaration'],
    manual: 'Occupational Underwriting Manual Sec 5.4 - Hazardous Classes',
  },
  RULE_SENIOR_MULTI_MORBIDITY: {
    evidence: ['Attending Physician Statement (APS)', 'Current medication list', 'Recent specialist letters'],
    manual: 'Reinsurance Medical Manual Sec 6.1 - Multi-Morbidity in Seniors',
  },
};

export interface UnderwritingAiCopilot {
  analyzeUncleanCase(
    applicant: ApplicantRequest,
    triggeredRules: TriggeredRule[],
    traceSnapshot: TraceSnapshot,
  ): Promise<AiCopilotBrief>;
}

/**
 * Deterministic fallback generator. Inspects the matched rules + trace snapshot and
 * synthesizes a context-aware brief that explains how the combined rules interact.
 * This is the default when no LLM API key is configured, guaranteeing zero-latency
 * offline demos while still producing realistic, rule-grounded output.
 */
function buildDeterministicBrief(
  applicant: ApplicantRequest,
  triggeredRules: TriggeredRule[],
  snapshot: TraceSnapshot,
): AiCopilotBrief {
  const ids = triggeredRules.map((r) => r.ruleId);
  const requiredEvidence = Array.from(
    new Set(ids.flatMap((id) => GUIDELINE_LIBRARY[id]?.evidence ?? [])),
  );
  const manualRefs = Array.from(
    new Set(ids.flatMap((id) => GUIDELINE_LIBRARY[id]?.manual ?? [])),
  );

  const vitals = `age ${applicant.age}, BMI ${applicant.bmi}, systolic BP ${applicant.systolicBp}, ${
    applicant.smoker ? 'current smoker' : 'non-smoker'
  }, sum assured ${applicant.sumAssured.toLocaleString()}`;

  const riskSummary =
    `${applicant.applicantId} was referred (UNCLEAN) by ${ids.length} rule(s): ` +
    `${ids.join(', ')}. Applicant profile (${vitals}). ` +
    (ids.length > 1
      ? 'These findings interact cumulatively, elevating combined morbidity/mortality risk beyond what any single factor implies.'
      : 'This single referral factor requires targeted evidence before an automated decision can be issued.');

  const recommendedAction =
    `Route to a senior medical underwriter. Collect the listed evidence, then re-rate. ` +
    `Current indicative loading from matched rules is driven by [${snapshot.matchedRuleIds.join(', ') || ids.join(', ')}].`;

  return {
    riskSummary,
    recommendedAction,
    requiredEvidence: requiredEvidence.length > 0 ? requiredEvidence : ['Full proposal & paramedical report'],
    manualGuidelineRef: manualRefs.join(' | ') || 'General Referral Guidelines',
    generatedBy: 'mock',
  };
}

/**
 * Live-mode prompt construction. Emits a structured instruction that a JSON-capable
 * LLM can follow, grounding it with the matched rows, the applicant snapshot and the
 * relevant mini-manual sections. Kept exported for the migration tool's prompt showcase.
 */
export function buildCopilotPrompt(
  applicant: ApplicantRequest,
  triggeredRules: TriggeredRule[],
  snapshot: TraceSnapshot,
): string {
  const context = {
    applicant,
    triggeredRules,
    matchedRows: snapshot.matchedRows,
    guidelineExcerpts: triggeredRules
      .map((r) => GUIDELINE_LIBRARY[r.ruleId])
      .filter(Boolean)
      .map((g) => ({ manual: g.manual, requiredEvidence: g.evidence })),
  };
  return [
    'You are a senior life & health underwriting copilot.',
    'Given the deterministic GoRules engine trace context below, produce a JSON object with keys:',
    'riskSummary (string), recommendedAction (string), requiredEvidence (array of strings), manualGuidelineRef (string).',
    'Base every claim strictly on the provided rule matches and guideline excerpts; do not invent coverage terms.',
    'CONTEXT_JSON:' + JSON.stringify(context),
  ].join('\n');
}

/**
 * Attempts a real structured LLM call (OpenAI Chat Completions or Anthropic Messages)
 * using fetch, depending on which API key is configured. Returns null on any failure or
 * missing key so the caller can fall back to the deterministic brief.
 */
async function tryLiveLlmBrief(
  applicant: ApplicantRequest,
  triggeredRules: TriggeredRule[],
  snapshot: TraceSnapshot,
): Promise<AiCopilotBrief | null> {
  const prompt = buildCopilotPrompt(applicant, triggeredRules, snapshot);
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const schemaHint = {
    type: 'object',
    properties: {
      riskSummary: { type: 'string' },
      recommendedAction: { type: 'string' },
      requiredEvidence: { type: 'array', items: { type: 'string' } },
      manualGuidelineRef: { type: 'string' },
    },
    required: ['riskSummary', 'recommendedAction', 'requiredEvidence', 'manualGuidelineRef'],
  };

  try {
    if (openaiKey) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Return only valid JSON matching the provided schema.' },
            { role: 'user', content: prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'uw_copilot_brief', strict: true, schema: schemaHint },
          },
          temperature: 0.2,
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? 'null');
        if (parsed?.riskSummary) return { ...parsed, generatedBy: 'live-llm' };
      }
    } else if (anthropicKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
          max_tokens: 1024,
          system: 'Return only valid JSON matching the provided schema.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        const text = data.content?.[0]?.text ?? 'null';
        const parsed = JSON.parse(text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
        if (parsed?.riskSummary) return { ...parsed, generatedBy: 'live-llm' };
      }
    }
  } catch {
    // Fall through to deterministic mode below.
  }
  return null;
}

/**
 * Factory that selects the provider based on the environment.
 * Live LLM is used only when an API key is present; otherwise the deterministic,
 * rule-grounded generator keeps the demo fully offline and reproducible.
 */
export function createCopilot(): UnderwritingAiCopilot {
  return {
    async analyzeUncleanCase(applicant, triggeredRules, traceSnapshot) {
      const hasKey = Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
      if (hasKey) {
        const live = await tryLiveLlmBrief(applicant, triggeredRules, traceSnapshot);
        if (live) return live;
      }
      return buildDeterministicBrief(applicant, triggeredRules, traceSnapshot);
    },
  };
}
