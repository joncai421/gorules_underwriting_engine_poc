import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Eye, Play } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { UwDecision } from '../apiTypes';

/** Req 4 & 8: explorer for the persisted `underwriting_decisions` rows in PostgreSQL. */

export interface ReplayRequest {
  ruleKey: string;
  version: number;
  trace: any;
}

interface Props {
  onReplay: (req: ReplayRequest) => void;
}

const DECISION_COLORS: Record<string, string> = {
  ACCEPT_AS_PER_APPLICATION: 'var(--clean)',
  ACCEPT_WITH_LOADING: 'var(--unclean)',
  ACCEPT_WITH_EXCLUSIONS: '#0d9488',
  REQUEST_ADDITIONAL_INFO: 'var(--accent)',
  POSTPONE: '#64748b',
  DECLINE: 'var(--decline)',
};

export default function DecisionHistoryTab({ onReplay }: Props) {
  const { apiFetch } = useAuth();
  const [decisions, setDecisions] = useState<UwDecision[]>([]);
  const [productFilter, setProductFilter] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('');
  const [selected, setSelected] = useState<UwDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (productFilter) params.set('productCode', productFilter);
      if (decisionFilter) params.set('finalDecision', decisionFilter);
      const data = await apiFetch(`/api/decisions?${params.toString()}`);
      setDecisions(data.decisions);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [apiFetch, productFilter, decisionFilter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productFilter, decisionFilter]);

  async function openDetail(row: UwDecision) {
    try {
      setSelected(await apiFetch(`/api/decisions/${row.id}`));
    } catch (e: any) {
      setError(e.message);
    }
  }

  const env = selected?.productOutcome ?? null;

  return (
    <div className="history-page">
      <div className="toolbar">
        <span className="title">Persisted UW Decisions (PostgreSQL)</span>
        <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)}>
          <option value="">All products</option>
          <option value="TERM_LIFE">TERM_LIFE</option>
          <option value="CRITICAL_ILLNESS">CRITICAL_ILLNESS</option>
        </select>
        <select value={decisionFilter} onChange={(e) => setDecisionFilter(e.target.value)}>
          <option value="">All decisions</option>
          {Object.keys(DECISION_COLORS).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button className="icon-btn" onClick={load} disabled={busy}>
          <RefreshCw size={14} /> Refresh
        </button>
        <span className="spacer" />
        <span className="badge">{decisions.length} rows</span>
      </div>

      {error && <div className="status err" style={{ padding: '8px 16px' }}>{error}</div>}

      <div className="body">
        <div className="table-area">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Timestamp</th><th>Applicant</th><th>Product</th><th>Mode</th>
                <th>Fund. Ver</th><th>Product Ver</th><th>Final Decision</th><th>Risk Class</th>
                <th>EM Debits</th><th>AI</th><th></th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id} className={selected?.id === d.id ? 'selected' : ''} onClick={() => openDetail(d)}>
                  <td>{new Date(d.createdAt).toLocaleString()}</td>
                  <td>{d.applicantId}</td>
                  <td>{d.productCode}</td>
                  <td>{d.executionMode}</td>
                  <td>v{d.fundamentalRuleVersion}{d.fundamentalPassed ? ' ✅' : ' ❌'}</td>
                  <td>{d.productRuleVersion ? `v${d.productRuleVersion}` : '-'}</td>
                  <td>
                    <span className="decision-tag" style={{ background: DECISION_COLORS[d.finalDecision] ?? '#334155' }}>
                      {d.finalDecision}
                    </span>
                  </td>
                  <td>{d.riskClass}</td>
                  <td>{d.totalEmDebits}</td>
                  <td>{d.aiCopilotBrief ? <span title="AI Copilot brief stored">✨</span> : ''}</td>
                  <td><Eye size={14} /></td>
                </tr>
              ))}
              {decisions.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
                  No persisted decisions yet — run a simulation in Rule Studio or POST /api/underwrite.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <aside className="drawer wide">
            <h2>Decision {selected.id.slice(0, 8)}</h2>
            <span className="muted">
              {selected.applicantId} · {selected.productCode} · {selected.executionMode} · {new Date(selected.createdAt).toLocaleString()}
              {selected.triggeredByUsername ? ` · by ${selected.triggeredByUsername}` : ''} · {selected.executionTimeMs}ms
            </span>

            <div className="section">
              <div className="label">Two-tier execution</div>
              <div className="result-row">
                <span>Fundamental ({selected.fundamentalRuleKey} v{selected.fundamentalRuleVersion})</span>
                <span>{selected.fundamentalPassed ? 'PASSED ✅' : 'FAILED ❌ - Halted'}</span>
              </div>
              <div className="result-row">
                <span>Product</span>
                <span>{selected.productRuleKey ? `${selected.productRuleKey} v${selected.productRuleVersion}` : 'SKIPPED'}</span>
              </div>
              <div className="result-row">
                <span>Final decision</span>
                <span className="decision-tag" style={{ background: DECISION_COLORS[selected.finalDecision] ?? '#334155' }}>
                  {selected.finalDecision} (+{selected.loadingPct}%)
                </span>
              </div>
            </div>

            {selected.productRuleKey && selected.executionTrace?.product && (
              <button
                className="primary icon-btn"
                onClick={() =>
                  onReplay({
                    ruleKey: selected.productRuleKey!,
                    version: selected.productRuleVersion!,
                    trace: selected.executionTrace.product,
                  })
                }
              >
                <Play size={14} /> Replay Trace in Visual Canvas
              </button>
            )}

            {env && (
              <div className="section">
                <div className="label">4-stage breakdown</div>
                <div className="result-row"><span>Step 1 · Sufficient</span><span>{env.step1SufficientInfo.isSufficient ? 'YES' : 'NO'}</span></div>
                <div className="result-row"><span>Step 2 · EM debits</span><span>{env.step2RiskAssessment.totalEmDebits} · excl: {env.step2RiskAssessment.exclusionCodes.join(', ') || '-'}</span></div>
                <div className="result-row"><span>Step 3 · Risk class</span><span>{env.step3RiskClassification.riskClass} ({env.step3RiskClassification.actuarialTableRating})</span></div>
                <div className="result-row"><span>Step 4 · Decision</span><span>{env.step4UnderwritingDecision.finalDecision}</span></div>
                <ul className="rule-list">
                  {env.step2RiskAssessment.matchedAssessmentRules.map((m) => (
                    <li key={m.ruleId}>
                      <span className="rid">{m.ruleId} (+{m.debits})</span>
                      <span className="rsub">{m.outcome} — {m.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!selected.fundamentalPassed && (
              <div className="section">
                <div className="label">Fundamental violations</div>
                <ul className="rule-list">
                  {(selected.fundamentalOutcome?.violations ?? []).map((v: any) => (
                    <li key={v.ruleId}>
                      <span className="rid">{v.ruleId}</span>
                      <span className="rsub">{v.fundamentalDecision} — {v.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selected.aiCopilotBrief && (
              <div className="copilot">
                <div className="label">AI Copilot brief · {selected.aiCopilotBrief.caseType}</div>
                <div className="field">{selected.aiCopilotBrief.riskSummary}</div>
                <div className="field"><b>Recommended:</b> {selected.aiCopilotBrief.recommendedDisposition}</div>
                <div className="field muted">{selected.aiCopilotBrief.manualGuidelineRef} · {selected.aiCopilotBrief.generatedBy}</div>
              </div>
            )}

            <details className="section">
              <summary className="label">Full request payload (JSONB)</summary>
              <pre className="json-block">{JSON.stringify(selected.requestPayload, null, 2)}</pre>
            </details>

            <button className="icon-btn" onClick={() => setSelected(null)}>Close</button>
          </aside>
        )}
      </div>
    </div>
  );
}
