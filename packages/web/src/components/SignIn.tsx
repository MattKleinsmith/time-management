export function SignIn() {
  return (
    <div className="signin">
      <div className="signin-card">
        <img src="/icons/icon.svg" alt="" width={72} height={72} />
        <h1>Time Manager</h1>
        <p>Your Google Calendar, with a denser interface and alerts that keep nagging until you acknowledge them.</p>
        <a className="btn primary big" href="/auth/login">
          Sign in with Google
        </a>
        <p className="muted small">
          Requests only calendar-events access and the read-only calendar list. Time Manager settings are stored as private
          extended properties on your own events; nothing is copied to another database.
        </p>
        <a className="muted small" href="/?mock=1">
          Try the demo with sample data (no account)
        </a>
      </div>
    </div>
  );
}
