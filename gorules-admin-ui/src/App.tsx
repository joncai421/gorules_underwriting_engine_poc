import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DecisionGraph } from '@gorules/jdm-editor';
import * as XLSX from 'xlsx';
import { RefreshCw, Play, Save, Plus, FileSpreadsheet, Sparkles } from 'lucide-react';
import testCasesFile from '../../shared/test-cases.json';

interface RuleSummary { id: string; fileName: string; ruleCount: number; }

interface SimResult {
  applicantId: string;
  derivedMetrics: { bmi: number; incomeMultiple: number };
  step1SufficientInfo: { isSufficient: boolean; missingDocuments: { docCode: string; reason: string }[] };
  step2RiskAssessment: {
    totalEmDebits: number;
    exclusionCodes: string[];
    hasDeclineTrigger: boolean;
    hasPostponeTrigger: boolean;
    hasComorbidityUncleanTrigger: boolean;
    matchedAssessmentRules: { ruleId: string; outcome: string; debits: number; reason: string }[];
  };
  step3RiskClassification: { riskClass: string; actuarialTableRating: string; loadingPct: number };
  step4UnderwritingDecision: {
    finalDecision: string;
    isUncleanReferral: boolean;
    loadingPct: number;
    exclusions: string[];
    requestedAdditionalInfo: { docCode: string }[];
  };
  executionTimeMs: number;
  trace?: any;
  aiCopilotBrief?: {
    caseType: string;
    riskSummary: string;
    recommendedDisposition: string;
    manualGuidelineRef: string;
    generatedBy?: string;
  };
}

const TEST_CASES = (testCasesFile as any).cases as {
  id: string;
  label: string;
  applicant: any;
}[];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('File read failed'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}

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
  const excelInputRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string, err = false) => {
    setStatus({ msg, err });
    setTimeout(() => setStatus((s) => (s.msg === msg ? { msg: '' } : s)), 5000);
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
      flash(`Onboarded RA_OCCUPATION_CLASS_4 + avocation rule -> v2-onboarded-rules (${data.onboarded.ruleCount} stage-2 rows)`);
    } catch (e: any) {
      flash(`Onboarding failed: ${e.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function onExcelUpload(file: File) {
    setBusy(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch('/api/rules/upload-excel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, base64, ruleId: editingId }),
      });
      const data: any = await res.json();
      if (data.error) throw new Error(data.error);
      setJdm(data.jdm);
      await loadRules();
      // Local parse just to report the row count of the workbook we imported.
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rowCount = data.uploaded?.rowCount ?? 0;
      flash(`Imported ${file.name} (${wb.SheetNames[0]}, ${rowCount} rows) into ${editingId} stage-2 table`);
    } catch (e: any) {
      flash(`Excel upload failed: ${e.message}`, true);
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

  const decision = sim?.step4UnderwritingDecision?.finalDecision;

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">Underwriting Rule Studio</span>
        <span className="badge">active: {activeId || '-'}</span>

        <select value={editingId} onChange={(e) => loadRule(e.target.value)} aria-label="Rule version">
          {rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} ({r.ruleCount} stage-2 rules)
            </option>
          ))}
        </select>

        <button className="icon-btn" onClick={() => loadRule(editingId)} title="Reload from engine">
          <RefreshCw size={14} /> Reload
        </button>

        <button className="icon-btn" onClick={onOnboard} disabled={busy} title="Append stage-2 occupation / avocation rules">
          <Plus size={14} /> 1-Click Onboard New Rule (Hazardous Occupation Class 4)
        </button>

        <button className="icon-btn" onClick={() => excelInputRef.current?.click()} disabled={busy} title="Import an Excel decision table">
          <FileSpreadsheet size={14} /> Upload Excel (Decision Table)
        </button>
        <input
          ref={excelInputRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onExcelUpload(f);
            e.target.value = '';
          }}
        />

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
          <span className="muted">12 canonical applicants from shared/test-cases.json</span>

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
            <>
              <div className="section">
                <div className="result-row">
                  <span>Stage 0 · Derived metrics</span>
                  <span>BMI {sim.derivedMetrics.bmi} · Multiple {sim.derivedMetrics.incomeMultiple}x</span>
                </div>
                <div className="result-row">
                  <span>Exec time</span>
                  <span>{sim.executionTimeMs}ms</span>
                </div>
              </div>

              <div className="section">
                <div className="result-row">
                  <span>Step 1 · Sufficient info?</span>
                  <span>{sim.step1SufficientInfo.isSufficient ? 'YES' : 'NO'}</span>
                </div>
                {sim.step1SufficientInfo.missingDocuments.length > 0 && (
                  <ul className="rule-list">
                    {sim.step1SufficientInfo.missingDocuments.map((d) => (
                      <li key={d.docCode}>
                        <span className="rid">{d.docCode}</span>
                        <span className="rsub">{d.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="section">
                <div className="result-row">
                  <span>Step 2 · Total EM debits</span>
                  <span>{sim.step2RiskAssessment.totalEmDebits}</span>
                </div>
                <div className="result-row">
                  <span>Exclusions</span>
                  <span>{sim.step2RiskAssessment.exclusionCodes.join(', ') || '-'}</span>
                </div>
                <ul className="rule-list">
                  {sim.step2RiskAssessment.matchedAssessmentRules.map((m) => (
                    <li key={m.ruleId}>
                      <span className="rid">{m.ruleId} (+{m.debits})</span>
                      <span className="rsub">{m.outcome} — {m.reason}</span>
                    </li>
                  ))}
                  {sim.step2RiskAssessment.matchedAssessmentRules.length === 0 && (
                    <li><span className="rsub">No risk debits collected</span></li>
                  )}
                </ul>
              </div>

              <div className="section">
                <div className="result-row">
                  <span>Step 3 · Risk class</span>
                  <span>{sim.step3RiskClassification.riskClass}</span>
                </div>
                <div className="result-row">
                  <span>Actuarial rating</span>
                  <span>{sim.step3RiskClassification.actuarialTableRating}</span>
                </div>
              </div>

              <div className="section">
                <div className="result-row">
                  <span>Step 4 · Decision</span>
                  <span className={`pill ${decision ?? ''}`}>{decision}</span>
                </div>
                <div className="result-row">
                  <span>Loading</span>
                  <span>+{sim.step4UnderwritingDecision.loadingPct}%</span>
                </div>
                <div className="result-row">
                  <span>Unclean referral</span>
                  <span>{String(sim.step4UnderwritingDecision.isUncleanReferral)}</span>
                </div>
              </div>
            </>
          )}

          {sim?.aiCopilotBrief && (
            <div className="copilot">
              <h3><Sparkles size={14} /> AI Copilot · {sim.aiCopilotBrief.caseType}</h3>
              <div className="field">
                <div className="label">Risk Summary</div>
                <div>{sim.aiCopilotBrief.riskSummary}</div>
              </div>
              <div className="field">
                <div className="label">Recommended Disposition</div>
                <div>{sim.aiCopilotBrief.recommendedDisposition}</div>
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
