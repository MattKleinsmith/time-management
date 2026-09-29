import { useState } from 'react';
import { asset, isStaticMode } from '../lib/api';
import { getClientId, setClientId, startLogin, redirectUri } from '../lib/auth';
import { useStore } from '../lib/store';

export function SignIn() {
  const staticMode = isStaticMode();
  const [clientId, setId] = useState(getClientId());
  const [showSetup, setShowSetup] = useState(!getClientId());
  const authError = useStore((s) => s.error);

  const signIn = () => {
    if (staticMode) {
      if (!clientId.trim()) {
        setShowSetup(true);
        return;
      }
      setClientId(clientId);
      startLogin({ clientId: clientId.trim() });
    } else {
      location.href = '/auth/login';
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <img src={asset('icons/icon.svg')} alt="" width={72} height={72} />
        <h1>Time Manager</h1>
        <p>Your Google Calendar, with a denser interface and alerts that keep nagging until you acknowledge them.</p>
        {authError ? <div className="notice">{authError}</div> : null}
        <button className="btn primary big" onClick={signIn}>
          Sign in with Google
        </button>
        {staticMode ? (
          <div className="setup">
            <button className="btn ghost small" onClick={() => setShowSetup(!showSetup)}>
              {showSetup ? 'Hide setup' : 'Setup / change client ID'}
            </button>
            {showSetup ? (
              <div className="stack" style={{ textAlign: 'left' }}>
                <label className="muted small">Google OAuth client ID (Web application)</label>
                <input value={clientId} onChange={(e) => setId(e.target.value)} placeholder="1234567890-abc.apps.googleusercontent.com" />
                <p className="muted small">
                  This static site has no server, so the browser signs in to Google directly. One-time setup: in the Google Cloud
                  console enable the <strong>Google Calendar API</strong>, create an OAuth client of type <strong>Web application</strong>, add
                  yourself as a test user on the consent screen, and register this exact redirect URI:
                </p>
                <code className="mono" style={{ wordBreak: 'break-all' }}>
                  {redirectUri()}
                </code>
                <p className="muted small">The client ID is stored only in this browser. Tokens last one hour and are renewed silently.</p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="muted small">
            Requests only calendar-events access and the read-only calendar list. Time Manager settings are stored as private
            extended properties on your own events; nothing is copied to another database.
          </p>
        )}
        <a className="muted small" href="?mock=1">
          Try the demo with sample data (no account)
        </a>
      </div>
    </div>
  );
}
