import { useCallback, useEffect, useMemo, useState } from 'react';
import { DecisionGraph } from '@gorules/jdm-editor';
import { RefreshCw, Play, Save, Plus, Sparkles } from 'lucide-react';
import testCasesFile from '../../shared/test-cases.json';

interface RuleSummary { id: string; fileName: string; ruleCount: number; }
interface SimResult {
  decision: 'CLEAN' | 'UNCLEAN' | 'DECLINE';
  basePremiumLoadingPct: number;
  triggeredRules: { ruleId: string; category: string; reason: string }[];
  executionTimeMs: number;
  trace?: any;
  aiCopilotBrief?: {
    riskSummary: string;
    recommendedAction: string;
    requiredEvidence: string[];
    manualGuidelineRef: string;
    generatedBy?: string;
  };
}

const TEST_CASES = (testCasesFile as any).cases as {
  id: string;
  label: string;
  applicant: any;
}[];

export default function App() {
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [editingId, setEditingId] = useState<string>('');
  const [jdm, setJdm] = useState<any>(null);

  const [selectedCaseId, setSelectedCaseId] = useState<string>(TEST_CASES[0].id);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [trace, setTrace] = useState<any>(undefined);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; err?: boolean }>({ msg: '' });

  const flash = (msg: string, err = false) => {
    setStatus({ msg, err });
    setTimeout(() => setStatus((s) => (s.msg === msg ? { msg: '' } : s)), 4000);
  };

  const loadRules = useCallback(async () => {
    const res = await fetch('/api/rules');
    const data: any = await res.json();
    setRules(data.rules);
    setActiveId(data.activeId);
    return data as { activeId: string; rules: RuleSummary[] };
  }, []);

  const loadRule = useCallback(async (id: string) => {
    const res = await fetch(`/api/rules/${id}`);
    if (!res.ok) return;
    const graph = await res.json();
    setEditingId(id);
    setJdm(graph);
    setSim(null);
    setTrace(undefined);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await loadRules();
        if (data.rules.length) await loadRule(data.activeId || data.rules[0].id);
      } catch (e: any) {
        flash(`Engine unreachable: ${e.message}`, true);
      }
    })();
  }, [loadRules, loadRule]);

  const selectedCase = useMemo(
    () => TEST_CASES.find((c) => c.id === selectedCaseId)!,
    [selectedCaseId],
  );

  async function onOnboard() {
    setBusy(true);
    try {
      const res = await fetch('/api/rules/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: activeId || 'v1-migrated-rules', newId: 'v2-onboarded-rules', activate: false }),
      });
      const data: any = await res.json();
      if (data.error) throw new Error(data.error);
      await loadRules();
      await loadRule('v2-onboarded-rules');
      flash(`Onboarded 2 rules -> v2-onboarded-rules (${data.onboarded.ruleCount} total rows)`);
    } catch (e: any) {
      flash(`Onboarding failed: ${e.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveDeploy() {
    setBusy(true);
    try {
      const res = await fetch(`/api/rules/${editingId}?activate=true`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(jdm),
      });
      const data: any = await res.json();
      if (data.error) throw new Error(data.error);
      await loadRules();
      flash(`Saved & hot-deployed ${editingId} (now active)`);
    } catch (e: any) {
      flash(`Save failed: ${e.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function onSimulate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/underwrite?aiAssist=true&rule=${editingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selectedCase.applicant),
      });
      const data: SimResult = await res.json();
      if ((data as any).error) throw new Error((data as any).error);
      setSim(data);
      // Feed the execution trace straight into the editor for green-path highlighting.
      setTrace(data.trace);
    } catch (e: any) {
      flash(`Simulation failed: ${e.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">Underwriting Rule Studio</span>
        <span className="badge">active: {activeId || '-'}</span>

        <select
          value={editingId}
          onChange={(e) => loadRule(e.target.value)}
          aria-label="Rule version"
        >
          {rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} ({r.ruleCount} rules)
            </option>
          ))}
        </select>

        <button className="icon-btn" onClick={() => loadRule(editingId)} title="Reload from engine">
          <RefreshCw size={14} /> Reload
        </button>

        <button className="icon-btn" onClick={onOnboard} disabled={busy} title="Inject onboarded occupation / senior rules">
          <Plus size={14} /> Onboard New Rule (Occupation Class 4 &amp; Smoker Surcharge)
        </button>

        <span className="spacer" />

        <button className="primary icon-btn" onClick={onSaveDeploy} disabled={busy}>
          <Save size={14} /> Save &amp; Hot-Deploy
        </button>
      </div>

      <div className="body">
        <div className="graph-area">
          {jdm ? (
            <DecisionGraph value={jdm} onChange={(v: any) => setJdm(v)} simulate={trace} />
          ) : (
            <div style={{ padding: 24, color: '#94a3b8' }}>Loading rule graph…</div>
          )}
        </div>

        <aside className="drawer">
          <h2>Live Simulator</h2>
          <span className="muted">Preset applicants from shared/test-cases.json</span>

          <select value={selectedCaseId} onChange={(e) => setSelectedCaseId(e.target.value)}>
            {TEST_CASES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}: {c.label}
              </option>
            ))}
          </select>

          <button className="primary icon-btn" onClick={onSimulate} disabled={busy}>
            <Play size={14} /> Run Simulation
          </button>

          {status.msg && <div className={`status${status.err ? ' err' : ''}`}>{status.msg}</div>}

          {sim && (
            <div className="section">
              <div className="result-row">
                <span>Decision</span>
                <span className={`pill ${sim.decision}`}>{sim.decision}</span>
              </div>
              <div className="result-row">
                <span>Base Loading</span>
                <span>+{sim.basePremiumLoadingPct}%</span>
              </div>
              <div className="result-row">
                <span>Exec time</span>
                <span>{sim.executionTimeMs}ms</span>
              </div>
              <ul className="rule-list">
                {sim.triggeredRules.map((r) => (
                  <li key={r.ruleId}>
                    <span className="rid">{r.ruleId}</span>
                    <span className="rsub">{r.category} — {r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sim && sim.decision === 'UNCLEAN' && sim.aiCopilotBrief && (
            <div className="copilot">
              <h3><Sparkles size={14} /> AI Copilot Assessment</h3>
              <div className="field">
                <div className="label">Risk Summary</div>
                <div>{sim.aiCopilotBrief.riskSummary}</div>
              </div>
              <div className="field">
                <div className="label">Recommended Action</div>
                <div>{sim.aiCopilotBrief.recommendedAction}</div>
              </div>
              <div className="field">
                <div className="label">Required Evidence</div>
                <ul className="evidence">
                  {sim.aiCopilotBrief.requiredEvidence.map((e) => <li key={e}>{e}</li>)}
                </ul>
              </div>
              <div className="field">
                <div className="label">Guideline Ref</div>
                <div>{sim.aiCopilotBrief.manualGuidelineRef}</div>
                <div className="label" style={{ marginTop: 6 }}>Source</div>
                <div>{sim.aiCopilotBrief.generatedBy}</div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
