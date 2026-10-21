import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, FileJson } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { AuditLog } from '../apiTypes';
import { RULE_LABELS } from '../apiTypes';

/** Req 3 & 8: chronological governance audit trail with filters and a JSON metadata modal. */

const ACTIONS = ['CREATED_DRAFT', 'UPDATED_DRAFT', 'SUBMITTED_FOR_APPROVAL', 'APPROVED_TO_LIVE', 'REJECTED', 'ARCHIVED', 'EXCEL_IMPORTED'];

const ACTION_COLOR: Record<string, string> = {
  CREATED_DRAFT: 'var(--accent)',
  UPDATED_DRAFT: '#64748b',
  SUBMITTED_FOR_APPROVAL: '#0d9488',
  APPROVED_TO_LIVE: 'var(--clean)',
  REJECTED: 'var(--decline)',
  ARCHIVED: '#475569',
  EXCEL_IMPORTED: 'var(--unclean)',
};

export default function AuditLogTab() {
  const { apiFetch } = useAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [ruleFilter, setRuleFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [jsonModal, setJsonModal] = useState<{ title: string; body: any } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (ruleFilter) params.set('ruleKey', ruleFilter);
      if (actionFilter) params.set('action', actionFilter);
      const data = await apiFetch(`/api/audit-logs?${params.toString()}`);
      setLogs(data.logs);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [apiFetch, ruleFilter, actionFilter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleFilter, actionFilter]);

  return (
    <div className="history-page">
      <div className="toolbar">
        <span className="title">Governance Audit Logs (rule_audit_logs)</span>
        <select value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value)}>
          <option value="">All rules</option>
          {Object.entries(RULE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <button className="icon-btn" onClick={load} disabled={busy}>
          <RefreshCw size={14} /> Refresh
        </button>
        <span className="spacer" />
        <span className="badge">{logs.length} events</span>
      </div>

      {error && <div className="status err" style={{ padding: '8px 16px' }}>{error}</div>}

      <div className="table-area" style={{ padding: '12px 16px', overflowY: 'auto' }}>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Timestamp</th><th>Rule</th><th>Ver</th><th>Action</th><th>Actor</th>
              <th>Transition</th><th>Comment</th><th>Snapshot</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.createdAt).toLocaleString()}</td>
                <td>{RULE_LABELS[l.ruleKey]?.replace(/^\[\w+\] /, '') ?? l.ruleKey}</td>
                <td>v{l.ruleVersion}</td>
                <td>
                  <span className="decision-tag" style={{ background: ACTION_COLOR[l.action] ?? '#334155' }}>{l.action}</span>
                </td>
                <td>{l.actorDisplayName ?? l.actorId} <span className="muted">({l.actorRole})</span></td>
                <td>{l.previousStatus ?? '—'} → {l.newStatus ?? '—'}</td>
                <td title={l.comment ?? ''} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.comment ?? ''}
                </td>
                <td>
                  {l.metadata ? (
                    <button className="icon-btn mini" onClick={() => setJsonModal({ title: `${l.action} v${l.ruleVersion} metadata`, body: l.metadata })}>
                      <FileJson size={13} /> diff
                    </button>
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
                No audit events yet for this filter.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {jsonModal && (
        <div className="modal-backdrop" onClick={() => setJsonModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{jsonModal.title}</h3>
            <pre className="json-block">{JSON.stringify(jsonModal.body, null, 2)}</pre>
            <button className="icon-btn" onClick={() => setJsonModal(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
