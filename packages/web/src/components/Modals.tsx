import { useStore } from '../lib/store';

export function ScopePromptModal() {
  const prompt = useStore((s) => s.scopePrompt);
  if (!prompt) return null;
  return (
    <div className="modal-backdrop" onClick={() => prompt.resolve(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{prompt.title}</h3>
        {prompt.message ? <p className="muted">{prompt.message}</p> : null}
        <div className="stack">
          <button className="btn" autoFocus onClick={() => prompt.resolve('instance')}>
            This event only
          </button>
          {prompt.allowFollowing ? (
            <button className="btn" onClick={() => prompt.resolve('following')}>
              This and following events
            </button>
          ) : null}
          <button className="btn" onClick={() => prompt.resolve('series')}>
            All events in the series
          </button>
          <button className="btn ghost" onClick={() => prompt.resolve(null)}>
            Cancel
          </button>
        </div>
        <p className="muted small">
          "All events" changes the recurring parent in Google Calendar (no exceptions are created). "This event only" creates a
          single exception, exactly like Google Calendar does.
        </p>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['n', 'New event'],
  ['t', 'Go to today'],
  ['← / →', 'Previous / next period'],
  ['d / w / g / h', 'Day / multi-day / agenda / now'],
  ['1–9', 'Show that many days'],
  ['j / k', 'Select next / previous event'],
  ['Enter', 'Edit selected event'],
  ['Delete', 'Delete selected event'],
  ['[ / ]', 'Move selected event 15 min earlier / later'],
  ['Shift + [ / ]', 'Shorten / lengthen selected event by 15 min'],
  ['a', 'Acknowledge the oldest active alert'],
  ['s', 'Snooze the oldest active alert 5 min'],
  ['r', 'Sync with Google Calendar'],
  ['/', 'Search'],
  [',', 'Settings'],
  ['+ / -', 'Zoom the time grid'],
  ['Esc', 'Close panel / clear selection'],
  ['?', 'This help'],
  ['Drag', 'Move an event; drag its bottom edge to resize; drag on empty grid to create'],
  ['Alt + drag', 'Duplicate an event'],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  const toggle = useStore((s) => s.toggleHelp);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={toggle}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard & mouse</h3>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
