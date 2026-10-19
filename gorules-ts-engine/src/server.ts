import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { getEngine } from './engine/uwEngine';
import { createCopilot, extractMatchedNodesFromTrace } from './ai/uncleanCaseCopilot';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

const applicantSchema = z.object({
  applicantId: z.string(),
  age: z.number(),
  bmi: z.number(),
  smoker: z.boolean(),
  systolicBp: z.number(),
  sumAssured: z.number(),
  medicalConditions: z.array(z.string()),
  occupationClass: z.number(),
});

// The two 1-click onboarded underwriting rows (PRD Requirement 5).
const DEFAULT_ONBOARD_ROWS = [
  {
    _id: 'r9',
    'in-age': '',
    'in-bmi': '',
    'in-bp': '',
    'in-smoker': '',
    'in-sa': '> 500000',
    'in-med': '',
    'in-occ': '4',
    'out-dec': '"UNCLEAN"',
    'out-id': '"RULE_HIGH_RISK_OCCUPATION"',
    'out-cat': '"OCCUPATIONAL"',
    'out-load': '0',
    'out-reason': '"Class 4 hazardous occupation with Sum Assured > 500k requires occupational questionnaire"',
  },
  {
    _id: 'r10',
    'in-age': '> 55',
    'in-bmi': '',
    'in-bp': '',
    'in-smoker': '',
    'in-sa': '',
    'in-med': 'len($) >= 2',
    'in-occ': '',
    'out-dec': '"UNCLEAN"',
    'out-id': '"RULE_SENIOR_MULTI_MORBIDITY"',
    'out-cat': '"MEDICAL"',
    'out-load': '0',
    'out-reason': '"Senior applicant with multiple conditions requires attending physician statement (APS)"',
  },
];

async function main() {
  const engine = getEngine();
  const copilot = createCopilot();

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true, activeRule: engine.getActiveId() }));

  // List available rule versions + the active one.
  app.get('/api/rules', async () => ({
    activeId: engine.getActiveId(),
    rules: engine.listRules(),
  }));

  // Fetch raw JDM JSON for a given rule id (Admin UI editor).
  app.get<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    try {
      return engine.readRaw(req.params.id);
    } catch (err: any) {
      reply.code(404);
      return { error: err.message };
    }
  });

  // Activate a rule version for subsequent /api/underwrite calls.
  app.post<{ Params: { id: string } }>('/api/rules/:id/activate', async (req, reply) => {
    try {
      engine.setActive(req.params.id);
      return { activeId: engine.getActiveId() };
    } catch (err: any) {
      reply.code(400);
      return { error: err.message };
    }
  });

  // Save updated JDM JSON (hot-reload). Optional ?activate=true to switch immediately.
  app.put<{ Params: { id: string }; Querystring: { activate?: string }; Body: any }>(
    '/api/rules/:id',
    async (req, reply) => {
      try {
        const summary = engine.saveRule(req.params.id, req.body);
        if (req.query.activate === 'true') engine.setActive(req.params.id);
        return { saved: summary, activeId: engine.getActiveId() };
      } catch (err: any) {
        reply.code(400);
        return { error: err.message };
      }
    },
  );

  // Create/append a rule version via API (1-click onboarding backend counterpart).
  app.post<{ Body: { sourceId?: string; newId?: string; rows?: unknown[]; activate?: boolean } }>(
    '/api/rules/onboard',
    async (req, reply) => {
      try {
        const sourceId = req.body?.sourceId ?? 'v1-migrated-rules';
        const newId = req.body?.newId ?? 'v2-onboarded-rules';
        const rows = req.body?.rows ?? DEFAULT_ONBOARD_ROWS;
        const result = engine.onboard(sourceId, newId, rows);
        if (req.body?.activate !== false) engine.setActive(newId);
        return { onboarded: result, activeId: engine.getActiveId() };
      } catch (err: any) {
        reply.code(400);
        return { error: err.message };
      }
    },
  );

  // Headless underwriting evaluation.
  app.post<{ Body: any; Querystring: { aiAssist?: string; rule?: string } }>(
    '/api/underwrite',
    async (req, reply) => {
      const parsed = applicantSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid ApplicantRequest payload', issues: parsed.error.issues };
      }
      const applicant = parsed.data;
      const wantAi = String(req.query.aiAssist).toLowerCase() === 'true';

      try {
        const outcome = await engine.evaluate(applicant, req.query.rule);
        const response: any = {
          decision: outcome.result.decision,
          basePremiumLoadingPct: outcome.result.basePremiumLoadingPct,
          triggeredRules: outcome.result.triggeredRules,
          executionTimeMs: outcome.executionTimeMs,
          trace: outcome.trace,
          activeRule: outcome.activeRuleId,
        };

        // Requirement 6: LLM extension fires ONLY for UNCLEAN and only when aiAssist is on.
        if (outcome.result.decision === 'UNCLEAN' && wantAi) {
          const snapshot = extractMatchedNodesFromTrace(outcome.trace);
          response.aiCopilotBrief = await copilot.analyzeUncleanCase(
            applicant,
            outcome.result.triggeredRules,
            snapshot,
          );
        }
        return response;
      } catch (err: any) {
        reply.code(500);
        return { error: err.message };
      }
    },
  );

  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`[gorules-ts-engine] listening on http://localhost:${PORT} (active rule: ${engine.getActiveId()})`);
}

main().catch((err) => {
  console.error('Failed to start gorules-ts-engine:', err);
  process.exit(1);
});
