import type { ReactNode } from 'react';
import { ArrowRight, Ban, CheckCircle2, Crosshair, XCircle } from 'lucide-react';
import type { PipelineResponse } from '../apiTypes';

/**
 * Req 1: presents the two-tier sequential contract enforced by `UwPipelineEngine.execute()` —
 * Stage A (FUNDAMENTAL) must pass before Stage B (per-PRODUCT) is loaded or executed.
 *
 * The chaining itself lives in TypeScript, not in any JDM graph, so this band renders it
 * explicitly. Purely presentational: every value is derived from the POST /api/underwrite
 * response already held by the caller.
 */

export interface StageRef {
  ruleKey: string;
  /** null until a run resolves which LIVE version was actually compiled. */
  version: number | null;
}

type CardState = 'idle' | 'ok' | 'bad' | 'ran' | 'skipped';
type GateState = 'idle' | 'open' | 'blocked';

interface Props {
  sim: PipelineResponse | null;
  productCode: string;
  /** The rule/version currently rendered on the canvas below. */
  viewing: StageRef | null;
  /** Which stage the retained execution trace belongs to. */
  traceSrc: 'fundamental' | 'product' | null;
  /** True only when that trace is actually being applied to the canvas. */
  traceLive: boolean;
  onOpenGraph: (ruleKey: string, version: number) => void;
}

export default function PipelineStageStrip({ sim, productCode, viewing, traceSrc, traceLive, onOpenGraph }: Props) {
  const passed = sim?.fundamental?.passed ?? false;
  const gate: GateState = !sim ? 'idle' : passed ? 'open' : 'blocked';

  const fundRef: StageRef = sim
    ? { ruleKey: sim.fundamental.ruleKey, version: sim.fundamental.version }
    : { ruleKey: 'FUNDAMENTAL_ELIGIBILITY', version: null };

  const prodRef: StageRef = sim?.product
    ? { ruleKey: sim.product.ruleKey, version: sim.product.version }
    : { ruleKey: `PRODUCT_${productCode}`, version: null };

  const traceRef = traceSrc === 'fundamental' ? fundRef : traceSrc === 'product' ? prodRef : null;
  const traceMatchesView = !!traceRef && traceRef.ruleKey === viewing?.ruleKey && traceRef.version === viewing?.version;
  const sameRuleOtherVersion =
    !!traceRef && traceRef.ruleKey === viewing?.ruleKey && traceRef.version !== viewing?.version;

  return (
    <div className="pipeline-strip">
      <div className="pipeline-head">
        <span className="label">Two-Tier Pipeline · sequential, short-circuiting</span>
        {sim ? (
          <span className="pipeline-meta">
            {sim.executionTimeMs}ms total · decisionId {sim.decisionId} · {sim.finalDecision}
          </span>
        ) : (
          <span className="pipeline-meta">Run a simulation to see which versions were compiled and which path executed.</span>
        )}
      </div>

      <div className="pipeline-flow">
        <StageCard
          tag="STAGE A"
          role="Global eligibility gate (AML · age · KYC · jurisdiction)"
          stage={fundRef}
          state={sim ? (passed ? 'ok' : 'bad') : 'idle'}
          verdict={sim ? (passed ? 'PASSED' : 'FAILED — HALTED') : 'not run'}
          icon={sim ? passed ? <CheckCircle2 size={13} /> : <XCircle size={13} /> : null}
          viewing={viewing}
        />

        <div className={`gate ${gate}`}>
          {gate === 'blocked' ? <Ban size={16} /> : <ArrowRight size={16} />}
          <span>
            {gate === 'idle' && 'runs only if A passes'}
            {gate === 'open' && 'gate PASSED →'}
            {gate === 'blocked' && 'SHORT-CIRCUIT'}
          </span>
          {gate === 'blocked' && <em>Stage B never loaded</em>}
        </div>

        <StageCard
          tag="STAGE B"
          role="Per-product 4-stage underwriting"
          stage={prodRef}
          state={!sim ? 'idle' : passed ? 'ran' : 'skipped'}
          verdict={!sim ? 'not run' : passed ? 'EXECUTED' : 'SKIPPED'}
          icon={null}
          viewing={viewing}
        />
      </div>

      {sim && !passed && (
        <div className="pipeline-note bad">
          <XCircle size={12} />
          <span>
            The orchestrator returned at the fundamental gate (PRD 4.1): the product rule was not fetched from
            PostgreSQL and no compiled decision was cached. Risk class reported as{' '}
            <code>{sim.riskClass}</code>.
          </span>
        </div>
      )}

      {traceRef && (
        <div className={`pipeline-trace ${traceLive ? 'live' : 'stale'}`}>
          <Crosshair size={12} />
          {traceLive ? (
            <span>
              Canvas matches the graph that ran — Stage {traceSrc === 'fundamental' ? 'A' : 'B'} ·{' '}
              <code>{traceRef.ruleKey}</code> v{traceRef.version}.
            </span>
          ) : sameRuleOtherVersion ? (
            <span>
              This canvas shows <code>{traceRef.ruleKey}</code> v{viewing?.version}, but the run compiled v
              {traceRef.version} — the LIVE row. Different graphs, so the trace is not applied here.
            </span>
          ) : (
            <span>
              This canvas shows <code>{viewing?.ruleKey ?? '—'}</code>, which did not execute this path — the trace belongs
              to <code>{traceRef.ruleKey}</code> v{traceRef.version}.
            </span>
          )}
          {!traceMatchesView && traceRef.version !== null && (
            <button className="icon-btn mini" onClick={() => onOpenGraph(traceRef.ruleKey, traceRef.version!)}>
              Open {traceSrc === 'fundamental' ? 'Stage A' : 'Stage B'} graph
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StageCard({
  tag,
  role,
  stage,
  state,
  verdict,
  icon,
  viewing,
}: {
  tag: string;
  role: string;
  stage: StageRef;
  state: CardState;
  verdict: string;
  icon: ReactNode;
  viewing: StageRef | null;
}) {
  const onCanvas =
    stage.version !== null && viewing?.ruleKey === stage.ruleKey && viewing?.version === stage.version;
  return (
    <div className={`pstage ${state}`}>
      <span className="tag">{tag}</span>
      <span className="nm">{stage.ruleKey}</span>
      <span className="role">{role}</span>
      <div className="pstage-foot">
        <span className="verdict">
          {icon}
          {verdict}
        </span>
        <span className="pversion">{stage.version === null ? 'LIVE @ runtime' : `v${stage.version}`}</span>
      </div>
      {stage.version !== null && (
        <span className={`oncanvas ${onCanvas ? 'yes' : ''}`}>
          {onCanvas ? '◉ this canvas' : 'not on this canvas'}
        </span>
      )}
    </div>
  );
}
