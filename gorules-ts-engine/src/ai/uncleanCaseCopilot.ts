import type { AiCopilotBrief, ApplicantRequest, UnderwritingEnvelope } from '../types';

/**
 * Snapshot of what actually fired inside the GoRules graph, extracted from the raw
 * execution trace. Grounds the copilot narrative in the concrete matched rows rather
 * than a generic template.
 */
export interface TraceSnapshot {
  matchedRuleIds: string[];
  missingDocCodes: string[];
  matchedRows: Record<string, unknown>[];
  inputSnapshot: Record<string, unknown>;
}

/**
 * Parses the zen-engine trace (`Record<nodeId, ZenEngineTrace>`) to recover the exact
 * stage-2 assessment rows, stage-1 missing documents, and the input field snapshot.
 * With `outputPath` + `passThrough`, each traced node's `output` carries the merged
 * context, so we scan every traced node for the keyed arrays we care about.
 */
export function extractMatchedNodesFromTrace(trace: unknown): TraceSnapshot {
  const snapshot: TraceSnapshot = { matchedRuleIds: [], missingDocCodes: [], matchedRows: [], inputSnapshot: {} };
  if (!trace || typeof trace !== 'object') return snapshot;

  for (const nodeTrace of Object.values(trace as Record<string, any>)) {
    const output = nodeTrace?.output;
    if (Array.isArray(output?.assessmentMatches)) {
      for (const row of output.assessmentMatches) {
        if (row?.ruleId && !snapshot.matchedRuleIds.includes(row.ruleId)) {
          snapshot.matchedRuleIds.push(row.ruleId);
          snapshot.matchedRows.push(row);
        }
      }
    }
    if (Array.isArray(output?.missingInfoMatches)) {
      for (const row of output.missingInfoMatches) {
        if (row?.missingDoc && !snapshot.missingDocCodes.includes(row.missingDoc)) {
          snapshot.missingDocCodes.push(row.missingDoc);
        }
      }
    }
    if (nodeTrace?.input && typeof nodeTrace.input === 'object' && !snapshot.inputSnapshot.applicantId) {
      snapshot.inputSnapshot = nodeTrace.input;
    }
  }
  return snapshot;
}

// Mini embedded reinsurance guideline library, keyed by rule / doc code. Used by the
// deterministic generator and injected as reference knowledge into the live LLM prompt.
const RULE_GUIDELINES: Record<string, { evidence: string[]; manual: string }> = {
  RA_OBESITY_CLASS_1: {
    evidence: ['HbA1c lab report', 'Fasting lipid profile'],
    manual: 'Swiss Re / Munich Re Life Manual Sec 4.2: Metabolic Syndrome & Hepatic Steatosis',
  },
  RA_METABOLIC_COMORBIDITY: {
    evidence: ['Liver ultrasound within 6 months', 'HbA1c lab report'],
    manual: 'Swiss Re / Munich Re Life Manual Sec 4.2: Metabolic Syndrome & Hepatic Steatosis',
  },
  RA_SMOKER_BP_SYNERGY: {
    evidence: ['Resting ECG', 'Repeat ambulatory BP monitoring (7-day)', 'Cardiac risk score (SCORE2)'],
    manual: 'Swiss Re Life Manual Sec 3.7: Cardiovascular Risk in Smokers',
  },
  RA_HYPERTENSION_S1: { evidence: ['Repeat ambulatory BP monitoring (7-day)'], manual: 'Reinsurance Medical Manual Sec 3.5: Hypertension Rating' },
  RA_HYPERTENSION_S2: { evidence: ['Resting ECG', 'Echocardiogram if ECG abnormal'], manual: 'Reinsurance Medical Manual Sec 3.6: Stage 2 Hypertension' },
  RA_MILD_OVERWEIGHT: { evidence: ['Standard paramedical report'], manual: 'Reinsurance Medical Manual Sec 4.1: Overweight Standard Loading' },
  RA_BENIGN_THYROID: { evidence: ['Thyroid ultrasound (TI-RADS classification)', 'Latest TSH result'], manual: 'Reinsurance Medical Manual Sec 5.3: Thyroid Nodules & Exclusion Riders' },
  RA_RECENT_SURGERY: { evidence: ['Discharge summary', 'Surgeon progress notes >= 6 months post-op'], manual: 'Reinsurance Operations Manual Sec 2.4: Post-Surgery Deferral' },
  RA_OCCUPATION_CLASS_4: { evidence: ['Occupational questionnaire (Class 4)', 'Hazard exposure declaration'], manual: 'Occupational Underwriting Manual Sec 5.4: Hazardous Classes' },
  RA_AVOCATION_EXTREME_SPORT: { evidence: ['Extreme hobby questionnaire', 'Activity frequency declaration'], manual: 'Avocation Underwriting Manual Sec 7.2: Adventure Sports' },
  RA_AGE_KNOCKOUT: { evidence: [], manual: 'Eligibility Guidelines Sec 1.1: Insurable Age Range' },
  RA_BP_CRISIS: { evidence: [], manual: 'Reinsurance Medical Manual Sec 3.6: Hypertensive Crisis' },
  RA_EXTREME_BMI: { evidence: [], manual: 'Reinsurance Medical Manual Sec 4.3: Morbid Obesity Knock-out' },
  RA_FINANCIAL_OVERINSURED: { evidence: [], manual: 'Financial Underwriting Manual Sec 2.1: Income Replacement Limits' },
};

const DOC_GUIDELINES: Record<string, { why: string; manual: string }> = {
  FINANCIAL_QUESTIONNAIRE: {
    why: 'signed Financial Questionnaire is required to verify insurable interest and source of premium',
    manual: 'Financial Underwriting Manual Sec 2.1: Non-Medical Limits & Sum Assured',
  },
  LIVER_ULTRASOUND: {
    why: 'liver ultrasound is required to rule out steatohepatitis before rating metabolic findings',
    manual: 'Swiss Re / Munich Re Life Manual Sec 4.2: Metabolic Syndrome & Hepatic Steatosis',
  },
  RESTING_ECG: {
    why: 'resting ECG is required for senior applicants at elevated sum assured to exclude subclinical cardiac disease',
    manual: 'Reinsurance Medical Manual Sec 3.5: Cardiovascular Screening Thresholds',
  },
};

export interface UnderwritingAiCopilot {
  analyze(envelope: UnderwritingEnvelope, applicant: ApplicantRequest, traceSnapshot: TraceSnapshot): Promise<AiCopilotBrief>;
}

function evidenceForRule(ruleId: string): string[] {
  return RULE_GUIDELINES[ruleId]?.evidence ?? [];
}

function manualsFor(codes: string[]): string[] {
  return [...new Set(codes.map((c) => RULE_GUIDELINES[c]?.manual).filter(Boolean) as string[])];
}

/**
 * Mode A - Step 1.1 assistant: drafts the structured agent/customer follow-up request
 * explaining WHY each missing document is required given the applicant's own metrics.
 */
function buildEvidenceRequestBrief(envelope: UnderwritingEnvelope, applicant: ApplicantRequest): AiCopilotBrief {
  const missing = envelope.step1SufficientInfo.missingDocuments;
  const whyLines = missing.map((m) => {
    const g = DOC_GUIDELINES[m.docCode];
    return `${m.docCode}: ${g ? g.why : m.reason}`;
  });
  const metrics = `derived.bmi = ${envelope.derivedMetrics.bmi}, incomeMultiple = ${envelope.derivedMetrics.incomeMultiple}, sumAssured = ${applicant.sumAssured.toLocaleString()}, age = ${applicant.age}`;
  return {
    caseType: 'REQUEST_ADDITIONAL_INFO',
    riskSummary:
      `Applicant ${applicant.applicantId} cannot be assessed yet (${metrics}). ` +
      `The sufficiency gate flagged ${missing.length} outstanding evidence item(s): ${whyLines.join('; ')}.`,
    recommendedDisposition:
      `Send an evidence follow-up request to the agent for: ${missing.map((m) => m.docCode).join(', ')}. ` +
      'Re-run underwriting automatically once documents are attached; do not rate the case until the gate passes.',
    manualGuidelineRef: [...new Set(missing.map((m) => DOC_GUIDELINES[m.docCode]?.manual ?? 'General Evidence Guidelines'))].join(' | '),
    generatedBy: 'mock',
  };
}

/**
 * Mode B - Step 2 -> Step 4 referral copilot: explains how the collected debits
 * interact and recommends a disposition among Accept With Loading / Exclusions / Postpone.
 */
function buildRiskAssessmentBrief(envelope: UnderwritingEnvelope, applicant: ApplicantRequest): AiCopilotBrief {
  const s2 = envelope.step2RiskAssessment;
  const s3 = envelope.step3RiskClassification;
  const ids = s2.matchedAssessmentRules.map((m) => m.ruleId);
  const requiredEvidence = [...new Set(ids.flatMap(evidenceForRule))];
  const debitLines = s2.matchedAssessmentRules
    .map((m) => `${m.ruleId} (+${m.debits} EM)`)
    .join(', ');

  const disposition =
    s2.exclusionCodes.length > 0 && s3.riskClass === 'STANDARD_WITH_EXCLUSION'
      ? `Confirm ACCEPT_WITH_EXCLUSIONS (${s2.exclusionCodes.join(', ')}) at standard rates`
      : s3.riskClass.startsWith('SUBSTANDARD')
        ? `Confirm ${envelope.step4UnderwritingDecision.finalDecision} (${s3.actuarialTableRating}) or request additional evidence to re-rate`
        : `Confirm ${envelope.step4UnderwritingDecision.finalDecision}`;

  return {
    caseType: 'UNCLEAN_RISK_ASSESSMENT',
    riskSummary:
      `Applicant ${applicant.applicantId} (bmi ${envelope.derivedMetrics.bmi}, systolic BP ${applicant.systolicBp}, ` +
      `${applicant.smoker ? 'smoker' : 'non-smoker'}) was referred with ${ids.length} interacting finding(s): ${debitLines}. ` +
      `Combined EM debits ${s2.totalEmDebits} classified into ${s3.riskClass} (${s3.actuarialTableRating}).`,
    recommendedDisposition:
      `${disposition}. Required evidence before final sign-off: ${requiredEvidence.length ? requiredEvidence.join('; ') : 'attending physician statement (APS)'}.`,
    manualGuidelineRef: manualsFor(ids).join(' | ') || 'General Referral Guidelines',
    generatedBy: 'mock',
  };
}

/**
 * Live-mode prompt construction (also reused by the migrator's LLM prompt showcase
 * pattern). Grounds a JSON-capable LLM in the matched rows + mini manual excerpts.
 */
export function buildCopilotPrompt(
  envelope: UnderwritingEnvelope,
  applicant: ApplicantRequest,
  snapshot: TraceSnapshot,
): string {
  const caseType = envelope.step4UnderwritingDecision.finalDecision === 'REQUEST_ADDITIONAL_INFO' ? 'REQUEST_ADDITIONAL_INFO' : 'UNCLEAN_RISK_ASSESSMENT';
  const context = {
    caseType,
    applicant,
    envelope,
    matchedRows: snapshot.matchedRows,
    guidelineExcerpts: Object.entries(RULE_GUIDELINES)
      .filter(([id]) => snapshot.matchedRuleIds.includes(id))
      .map(([, g]) => ({ manual: g.manual, requiredEvidence: g.evidence })),
  };
  return [
    'You are a senior life & health underwriting copilot.',
    'Given the deterministic GoRules engine envelope and trace context below, produce a JSON object with keys:',
    'caseType (string), riskSummary (string), recommendedDisposition (string), manualGuidelineRef (string).',
    'Base every claim strictly on the provided rule matches and guideline excerpts; do not invent coverage terms.',
    'CONTEXT_JSON:' + JSON.stringify(context),
  ].join('\n');
}

async function tryLiveLlmBrief(
  envelope: UnderwritingEnvelope,
  applicant: ApplicantRequest,
  snapshot: TraceSnapshot,
): Promise<AiCopilotBrief | null> {
  const prompt = buildCopilotPrompt(envelope, applicant, snapshot);
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const schemaHint = {
    type: 'object',
    properties: {
      caseType: { type: 'string' },
      riskSummary: { type: 'string' },
      recommendedDisposition: { type: 'string' },
      manualGuidelineRef: { type: 'string' },
    },
    required: ['caseType', 'riskSummary', 'recommendedDisposition', 'manualGuidelineRef'],
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
 * Factory selecting the provider from the environment. Live LLM only when a key is
 * present; otherwise deterministic, rule-grounded briefs keep the demo offline and
 * reproducible. CLEAN/DECLINE cases never reach this code (zero LLM latency, 100%
 * deterministic compliance) - the server only calls it when isUncleanReferral is true.
 */
export function createCopilot(): UnderwritingAiCopilot {
  return {
    async analyze(envelope, applicant, traceSnapshot) {
      const modeA = envelope.step4UnderwritingDecision.finalDecision === 'REQUEST_ADDITIONAL_INFO';
      const hasKey = Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
      if (hasKey) {
        const live = await tryLiveLlmBrief(envelope, applicant, traceSnapshot);
        if (live) return live;
      }
      return modeA
        ? buildEvidenceRequestBrief(envelope, applicant)
        : buildRiskAssessmentBrief(envelope, applicant);
    },
  };
}
