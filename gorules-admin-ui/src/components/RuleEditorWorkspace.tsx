import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DecisionGraph } from '@gorules/jdm-editor';
import { RefreshCw, Play, Save, SendHorizonal, Check, X, FileSpreadsheet, CopyPlus, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { ReplayRequest } from './DecisionHistoryTab';
import testCasesFile from '../../../shared/test-cases.json';
import type { PipelineResponse, RuleGroup, RuleVersion } from '../apiTypes';
import { RULE_LABELS } from '../apiTypes';

/** Req 2 & 8: JDM editor + version selector + Draft/Submit/Approve workflow bar + two-tier simulator. */

interface Props {
  replay?: ReplayRequest | null;
  onReplayConsumed?: () => void;
}

const TEST_CASES = (testCasesFile as any).cases as { id: string; label: string; applicant: any }[];

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

export default function RuleEditorWorkspace({ replay, onReplayConsumed }: Props) {
  const { user, apiFetch, can } = useAuth();

  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [ruleKey, setRuleKey] = useState<string>('');
  const [version, setVersion] = useState<number>(0);
  const [detail, setDetail] = useState<RuleVersion | null>(null);
  const [jdm, setJdm] = useState<any>(null);
  const [dirty, setDirty] = useState(false);

  const [productCode, setProductCode] = useState<'TERM_LIFE' | 'CRITICAL_ILLNESS'>('TERM_LIFE');
  const [selectedCaseId, setSelectedCaseId] = useState<string>(TEST_CASES[0].id);
  const [sim, setSim] = useState<PipelineResponse | null>(null);
  const [trace, setTrace] = useState<any>(undefined);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; err?: boolean }>({ msg: '' });
  const [rejectComment, setRejectComment] = useState('');
  const excelInputRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string, err = false) => {
    setStatus({ msg, err });
    setTimeout(() => setStatus((s) => (s.msg === msg ? { msg: '' } : s)), 6000);
  };

  const selectedGroup = useMemo(() => groups.find((g) => g.ruleKey === ruleKey) ?? null, [groups, ruleKey]);
  const selectedVersion = useMemo(
    () => selectedGroup?.versions.find((v) => v.version === version) ?? null,
    [selectedGroup, version],
  );

  const loadVersions = useCallback(
    async (keepKey?: string, keepVersion?: number) => {
      const data = await apiFetch('/api/rules');
      const gs: RuleGroup[] = data.rules;
      setGroups(gs);
      const key = gs.find((g) => g.ruleKey === (keepKey || ruleKey)) ? (keepKey || ruleKey) : gs[0]?.ruleKey ?? '';
      const grp = gs.find((g) => g.ruleKey === key);
      const ver =
        keepVersion !== undefined && grp?.versions.some((v) => v.version === keepVersion)
          ? keepVersion
          : grp?.versions.find((v) => v.status === 'LIVE')?.version ?? grp?.versions[0]?.version ?? 0;
      setRuleKey(key);
      setVersion(ver);
      return gs;
    },
    [apiFetch, ruleKey],
  );

  const loadVersionDetail = useCallback(
    async (key: string, ver: number) => {
      if (!key || !ver) return;
      const row: RuleVersion = await apiFetch(`/api/rules/${key}/versions/${ver}`);
      setDetail(row);
      setJdm(row.jdmContent);
      setDirty(false);
      setSim(null);
      setTrace(undefined);
    },
    [apiFetch],
  );

  useEffect(() => {
    (async () => {
      try {
        const gs = await loadVersions();
        if (gs.length) {
          const grp = gs.find((g) => g.ruleKey === ruleKey) ?? gs[0];
          const live = grp.versions.find((v) => v.status === 'LIVE') ?? grp.versions[0];
          setRuleKey(grp.ruleKey);
          setVersion(live.version);
          await loadVersionDetail(grp.ruleKey, live.version);
        }
      } catch (e: any) {
        flash(`Engine unreachable: ${e.message}`, true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ruleKey && version && detail?.version !== version) loadVersionDetail(ruleKey, version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey, version]);

  // DecisionHistoryTab "Replay Trace in Visual Canvas": load the decision's product version & highlight its trace.
  useEffect(() => {
    if (!replay) return;
    (async () => {
      try {
        await loadVersions(replay.ruleKey, replay.version);
        setRuleKey(replay.ruleKey);
        setVersion(replay.version);
        await loadVersionDetail(replay.ruleKey, replay.version);
        setTrace(replay.trace);
        flash(`Replaying persisted trace on ${replay.ruleKey} v${replay.version}`);
      } catch (e: any) {
        flash(`Replay failed: ${e.message}`, true);
      } finally {
        onReplayConsumed?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay]);

  const canEditVersion = can('edit') && (selectedVersion?.status === 'DRAFT' || selectedVersion?.status === 'REJECTED');
  const isViewer = user?.role === 'VIEWER';
  const editorReadOnly = !canEditVersion || isViewer;

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      flash(e.message || 'Request failed', true);
    } finally {
      setBusy(false);
    }
  }

  function onCreateDraft() {
    guard(async () => {
      const data = await apiFetch(`/api/rules/${ruleKey}/draft`, {
        method: 'POST',
        body: JSON.stringify({ changeNotes: `Draft created from v${version} (${selectedVersion?.status}) by ${user?.displayName}` }),
      });
      await loadVersions(ruleKey, data.draft.version);
      setVersion(data.draft.version);
      await loadVersionDetail(ruleKey, data.draft.version);
      flash(data.created ? `Created DRAFT v${data.draft.version} cloned from LIVE` : `Re-opened existing DRAFT v${data.draft.version}`);
    });
  }

  function onSaveDraft() {
    guard(async () => {
      const data = await apiFetch(`/api/rules/${ruleKey}/versions/${version}/draft`, {
        method: 'PUT',
        body: JSON.stringify(jdm),
      });
      await loadVersions(ruleKey, version);
      setDetail(data.saved);
      setDirty(false);
      flash(`Saved DRAFT v${version} to PostgreSQL`);
    });
  }

  function onSubmit() {
    guard(async () => {
      await apiFetch(`/api/rules/${ruleKey}/versions/${version}/submit`, { method: 'POST' });
      await loadVersions(ruleKey, version);
      await loadVersionDetail(ruleKey, version);
      flash(`Submitted v${version} for approval (PENDING_APPROVAL)`);
    });
  }

  function onApprove() {
    guard(async () => {
      const data = await apiFetch(`/api/rules/${ruleKey}/versions/${version}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment: `Approved & published from Rule Studio by ${user?.displayName}` }),
      });
      await loadVersions(ruleKey, version);
      await loadVersionDetail(ruleKey, version);
      flash(`v${version} is now LIVE${data.archivedVersion ? ` (v${data.archivedVersion} archived)` : ''} — engine cache invalidated`);
    });
  }

  function onReject() {
    if (!rejectComment.trim()) {
      flash('A rejection comment is mandatory', true);
      return;
    }
    guard(async () => {
      await apiFetch(`/api/rules/${ruleKey}/versions/${version}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reviewComment: rejectComment.trim() }),
      });
      setRejectComment('');
      await loadVersions(ruleKey, version);
      await loadVersionDetail(ruleKey, version);
      flash(`Rejected v${version}: back to author`);
    });
  }

  function onExcelUpload(file: File) {
    guard(async () => {
      const base64 = await fileToBase64(file);
      const data = await apiFetch(`/api/rules/${ruleKey}/upload-excel`, {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, base64, version }),
      });
      setJdm(data.saved.jdmContent);
      setDirty(false);
      await loadVersions(ruleKey, version);
      flash(`Imported ${file.name} (${data.uploaded.rowCount} stage-2 rows) into DRAFT v${version}`);
    });
  }

  function onSimulate() {
    guard(async () => {
      const tc = TEST_CASES.find((c) => c.id === selectedCaseId)!;
      const data: PipelineResponse = await apiFetch('/api/underwrite', {
        method: 'POST',
        body: JSON.stringify({ productCode, executionMode: 'SIMULATION', aiAssist: true, applicant: tc.applicant }),
      });
      setSim(data);
      // Highlight the executed path: product trace when Stage B ran, else fundamental trace on the gate graph.
      setTrace(data.haltedAtFundamental ? data.trace.fundamental : data.trace.product);
    });
  }

  const decision = sim?.step4UnderwritingDecision?.finalDecision ?? sim?.finalDecision;

  return (
    <>
      <div className="toolbar">
        <span className="title">Rule Studio</span>

        <select aria-label="Rule" value={ruleKey} onChange={(e) => setRuleKey(e.target.value)} disabled={groups.length === 0}>
          {groups.map((g) => (
            <option key={g.ruleKey} value={g.ruleKey}>
              {RULE_LABELS[g.ruleKey] ?? g.name}
            </option>
          ))}
        </select>

        <select aria-label="Version" value={version} onChange={(e) => setVersion(Number(e.target.value))}>
          {(selectedGroup?.versions ?? []).map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} ({v.status})
            </option>
          ))}
        </select>

        <button className="icon-btn" onClick={() => guard(() => loadVersionDetail(ruleKey, version))} title="Reload from PostgreSQL">
          <RefreshCw size={14} /> Reload
        </button>

        {selectedVersion?.status === 'LIVE' && can('edit') && (
          <button className="icon-btn" onClick={onCreateDraft} disabled={busy} title="Clone the LIVE version into a new DRAFT">
            <CopyPlus size={14} /> Create New Draft from Live
          </button>
        )}

        {canEditVersion && (
          <>
            <button className="icon-btn" onClick={() => excelInputRef.current?.click()} disabled={busy} title="Import an Excel decision table into this DRAFT">
              <FileSpreadsheet size={14} /> Upload Excel
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
            <button className="primary icon-btn" onClick={onSaveDraft} disabled={busy || !dirty} title="Persist edited JDM to rule_definitions">
              <Save size={14} /> Save Draft
            </button>
            <button className="icon-btn" onClick={onSubmit} disabled={busy || dirty} title="DRAFT -> PENDING_APPROVAL">
              <SendHorizonal size={14} /> Submit for Approval
            </button>
          </>
        )}

        {selectedVersion?.status === 'PENDING_APPROVAL' && can('approve') && (
          <>
            <button className="approve icon-btn" onClick={onApprove} disabled={busy} title="Promote to LIVE (maker-checker enforced)">
              <Check size={14} /> Approve &amp; Publish to LIVE
            </button>
            <input
              className="reject-comment"
              placeholder="Rejection reason (mandatory)"
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
            />
            <button className="reject icon-btn" onClick={onReject} disabled={busy}>
              <X size={14} /> Reject
            </button>
          </>
        )}

        <span className="spacer" />

        {selectedVersion && (
          <span className={`status-pill ${selectedVersion.status}`}>{selectedVersion.status}</span>
        )}
        {isViewer && <span className="badge">VIEWER · read-only</span>}
        {editorReadOnly && !isViewer && selectedVersion && selectedVersion.status !== 'PENDING_APPROVAL' && (
          <span className="badge">read-only ({selectedVersion.status})</span>
        )}
      </div>

      <div className="body">
        <div className="graph-area">
          {jdm ? (
            <DecisionGraph value={jdm} onChange={(v: any) => { setJdm(v); setDirty(true); }} simulate={trace} disabled={editorReadOnly} />
          ) : (
            <div style={{ padding: 24, color: '#94a3b8' }}>Loading rule graph…</div>
          )}
        </div>

        <aside className="drawer">
          <h2>Two-Tier Live Simulator</h2>
          <span className="muted">
            Fundamental gate → {productCode === 'TERM_LIFE' ? 'PRODUCT_TERM_LIFE' : 'PRODUCT_CRITICAL_ILLNESS'} (4-stage).
            Presets include Fundamental knockouts.
          </span>

          <div className="result-row">
            <span>Target product</span>
            <select value={productCode} onChange={(e) => setProductCode(e.target.value as any)} style={{ width: 190 }}>
              <option value="TERM_LIFE">TERM_LIFE</option>
              <option value="CRITICAL_ILLNESS">CRITICAL_ILLNESS</option>
            </select>
          </div>

          <select value={selectedCaseId} onChange={(e) => setSelectedCaseId(e.target.value)}>
            {TEST_CASES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}: {c.label}
              </option>
            ))}
          </select>

          <button className="primary icon-btn" onClick={onSimulate} disabled={busy}>
            <Play size={14} /> Run Two-Tier Simulation
          </button>

          {status.msg && <div className={`status${status.err ? ' err' : ''}`}>{status.msg}</div>}

          {sim && (
            <>
              <div className="stage-banner">
                <span className={`stage-badge ${sim.fundamental.passed ? 'ok' : 'bad'}`}>
                  Fundamental Rule (v{sim.fundamental.version}):{' '}
                  {sim.fundamental.passed ? 'PASSED' : 'FAILED - Halted'} {sim.fundamental.passed ? '✅' : '❌'}
                </span>
                <span className={`stage-badge ${sim.haltedAtFundamental ? 'skip' : 'ok'}`}>
                  {sim.product
                    ? `Product Rule (${sim.product.ruleKey} v${sim.product.version}): ${sim.product ? decision : '-'}` +
                      (sim.loadingPct ? ` (+${sim.loadingPct}%)` : '')
                    : 'Product Rule: SKIPPED (short-circuit)'}
                </span>
                <span className="muted" style={{ fontSize: 11 }}>decisionId saved to PostgreSQL: {sim.decisionId}</span>
              </div>

              {!sim.fundamental.passed && (
                <div className="section">
                  <div className="result-row">
                    <span>Fundamental outcome</span>
                    <span className={`pill ${sim.finalDecision}`}>{sim.finalDecision}</span>
                  </div>
                  <ul className="rule-list">
                    {(sim.fundamental.outcome?.violations ?? []).map((v: any) => (
                      <li key={v.ruleId}>
                        <span className="rid">{v.ruleId}</span>
                        <span className="rsub">{v.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {sim.product && sim.step4UnderwritingDecision && (
                <>
                  <div className="section">
                    <div className="result-row">
                      <span>Stage 0 · Derived metrics</span>
                      <span>BMI {sim.derivedMetrics!.bmi} · Multiple {sim.derivedMetrics!.incomeMultiple}x</span>
                    </div>
                    <div className="result-row">
                      <span>Exec time</span>
                      <span>{sim.executionTimeMs}ms</span>
                    </div>
                  </div>

                  <div className="section">
                    <div className="result-row">
                      <span>Step 1 · Sufficient info?</span>
                      <span>{sim.step1SufficientInfo!.isSufficient ? 'YES' : 'NO'}</span>
                    </div>
                    {sim.step1SufficientInfo!.missingDocuments.length > 0 && (
                      <ul className="rule-list">
                        {sim.step1SufficientInfo!.missingDocuments.map((d) => (
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
                      <span>{sim.step2RiskAssessment!.totalEmDebits}</span>
                    </div>
                    <div className="result-row">
                      <span>Exclusions</span>
                      <span>{sim.step2RiskAssessment!.exclusionCodes.join(', ') || '-'}</span>
                    </div>
                    <ul className="rule-list">
                      {sim.step2RiskAssessment!.matchedAssessmentRules.map((m) => (
                        <li key={m.ruleId}>
                          <span className="rid">{m.ruleId} (+{m.debits})</span>
                          <span className="rsub">{m.outcome} — {m.reason}</span>
                        </li>
                      ))}
                      {sim.step2RiskAssessment!.matchedAssessmentRules.length === 0 && (
                        <li><span className="rsub">No risk debits collected</span></li>
                      )}
                    </ul>
                  </div>

                  <div className="section">
                    <div className="result-row">
                      <span>Step 3 · Risk class</span>
                      <span>{sim.step3RiskClassification!.riskClass}</span>
                    </div>
                    <div className="result-row">
                      <span>Actuarial rating</span>
                      <span>{sim.step3RiskClassification!.actuarialTableRating}</span>
                    </div>
                  </div>

                  <div className="section">
                    <div className="result-row">
                      <span>Step 4 · Decision</span>
                      <span className={`pill ${sim.finalDecision}`}>{sim.finalDecision}</span>
                    </div>
                    <div className="result-row">
                      <span>Loading</span>
                      <span>+{sim.step4UnderwritingDecision!.loadingPct}%</span>
                    </div>
                    <div className="result-row">
                      <span>Unclean referral</span>
                      <span>{String(sim.isUncleanReferral)}</span>
                    </div>
                  </div>
                </>
              )}

              {sim.aiCopilotBrief && (
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
            </>
          )}

          {detail && (
            <div className="section">
              <div className="result-row"><span>Created by</span><span>{detail.createdByName ?? detail.createdBy}</span></div>
              {detail.submittedBy && detail.submittedAt && (
                <div className="result-row"><span>Submitted</span><span>{new Date(detail.submittedAt).toLocaleString()}</span></div>
              )}
              {detail.reviewComment && (
                <div className="result-row"><span>Review note</span><span title={detail.reviewComment}>{(detail.reviewComment ?? '').slice(0, 28)}…</span></div>
              )}
              {detail.changeNotes && (
                <div className="result-row"><span>Change notes</span><span title={detail.changeNotes}>{(detail.changeNotes ?? '').slice(0, 28)}…</span></div>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
