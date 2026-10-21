import { useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import RuleEditorWorkspace from './components/RuleEditorWorkspace';
import DecisionHistoryTab, { type ReplayRequest } from './components/DecisionHistoryTab';
import AuditLogTab from './components/AuditLogTab';

/** PRD v3 Admin UI shell: Quick Auth bar + 3 governance tabs. */

const DEMO_USERS = ['alice_viewer', 'bob_author', 'carol_approver', 'dave_admin'] as const;

const ROLE_PILL: Record<string, string> = {
  VIEWER: 'role-viewer',
  RULE_AUTHOR: 'role-author',
  RULE_APPROVER: 'role-approver',
  ADMIN: 'role-admin',
};

function LoginPanel() {
  const { login } = useAuth();
  const [username, setUsername] = useState('alice_viewer');
  const [password, setPassword] = useState('pass123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function doLogin(u = username, p = password) {
    setBusy(true);
    setError('');
    try {
      await login(u, p);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-center">
      <div className="login-card">
        <h2><ShieldCheck size={18} /> Underwriting Governance Console</h2>
        <span className="muted">Authenticate to access Rule Studio, UW Decision History and Audit Logs (Req 7 RBAC).</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
        {error && <div className="status err">{error}</div>}
        <button className="primary icon-btn" onClick={() => doLogin()} disabled={busy}>Login</button>
        <div className="label" style={{ marginTop: 12 }}>Quick switch demo user (1-click, password pre-filled)</div>
        <div className="quick-switch">
          {DEMO_USERS.map((u) => (
            <button key={u} className="icon-btn" disabled={busy} onClick={() => doLogin(u, 'pass123')}>{u}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const { user, logout, login, can } = useAuth();
  const [tab, setTab] = useState<'studio' | 'decisions' | 'audit'>('studio');
  const [replay, setReplay] = useState<ReplayRequest | null>(null);
  const [switchError, setSwitchError] = useState('');

  if (!user) return <LoginPanel />;

  function onReplay(req: ReplayRequest) {
    setReplay(req);
    setTab('studio');
  }

  return (
    <div className="app">
      <div className="auth-bar">
        <span className="title">GoRules Underwriting Engine · PoC v3</span>

        <nav className="tabs">
          <button className={tab === 'studio' ? 'tab active' : 'tab'} onClick={() => setTab('studio')}>
            1. Rule Studio &amp; Simulator
          </button>
          <button className={tab === 'decisions' ? 'tab active' : 'tab'} onClick={() => setTab('decisions')}>
            2. Persisted UW Decisions (DB)
          </button>
          <button className={tab === 'audit' ? 'tab active' : 'tab'} onClick={() => setTab('audit')}>
            3. Governance Audit Logs
          </button>
        </nav>

        <span className="spacer" />

        <span className="user-badge">
          {user.displayName}
          <span className={`role-pill ${ROLE_PILL[user.role]}`}>{user.role}</span>
        </span>
        <select
          aria-label="Quick switch user"
          value=""
          onChange={(e) => {
            const picked = e.target.value;
            e.target.value = '';
            if (!picked) return;
            // 1-click RBAC switch: re-login as the picked demo user with the known PoC password.
            login(picked, 'pass123')
              .then(() => setSwitchError(''))
              .catch((err: any) => setSwitchError(err.message));
          }}
        >
          <option value="">Switch user…</option>
          {DEMO_USERS.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        <button className="icon-btn" onClick={logout} title="Sign out">
          <LogOut size={14} /> Logout
        </button>
      </div>

      {switchError && <div className="status err" style={{ padding: '6px 16px' }}>{switchError}</div>}

      {tab === 'studio' && (
        <RuleEditorWorkspace replay={replay} onReplayConsumed={() => setReplay(null)} key={can('edit') ? 'edit' : 'ro'} />
      )}
      {tab === 'decisions' && <DecisionHistoryTab onReplay={onReplay} />}
      {tab === 'audit' && <AuditLogTab />}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
