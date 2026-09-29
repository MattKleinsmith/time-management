import { useEffect, useMemo, useState } from 'react';
import { ALERT_PRESETS, defaultTmConfig, describeRecurrence, type AlertPolicy, type EditScope, type EventInstance, type TmConfig } from '@tm/core';
import { useStore, type Draft } from '../lib/store';
import { fmtDuration, fromInputs, toInputDate, toInputTime } from '../lib/format';

const MIN = 60_000;

export function EventEditor() {
  const editor = useStore((s) => s.editor);
  if (!editor) return null;
  return <aside className="editor">{editor.mode === 'create' ? <CreateForm draft={editor.draft} /> : <EditForm inst={editor.instance} />}</aside>;
}

// ---- shared pieces --------------------------------------------------------

function TimeFields({
  start,
  end,
  allDay,
  onChange,
  disabled,
}: {
  start: Date;
  end: Date;
  allDay: boolean;
  disabled?: boolean;
  onChange: (next: { start: Date; end: Date; allDay: boolean }) => void;
}) {
  const snap = useStore((s) => s.settings.snapMinutes);
  const duration = end.getTime() - start.getTime();
  const shift = (ms: number) => onChange({ start: new Date(start.getTime() + ms), end: new Date(end.getTime() + ms), allDay });
  const setDuration = (ms: number) => onChange({ start, end: new Date(start.getTime() + Math.max(snap * MIN, ms)), allDay });
  return (
    <div className="time-fields">
      <label className="row">
        <input type="checkbox" checked={allDay} disabled={disabled} onChange={(e) => onChange({ start, end, allDay: e.target.checked })} /> All day
      </label>
      <div className="row">
        <input type="date" value={toInputDate(start)} disabled={disabled} onChange={(e) => e.target.value && onChange({ start: fromInputs(e.target.value, toInputTime(start)), end: new Date(fromInputs(e.target.value, toInputTime(start)).getTime() + duration), allDay })} />
        {!allDay ? (
          <input type="time" step={60} value={toInputTime(start)} disabled={disabled} onChange={(e) => e.target.value && onChange({ start: fromInputs(toInputDate(start), e.target.value), end: new Date(fromInputs(toInputDate(start), e.target.value).getTime() + duration), allDay })} />
        ) : null}
      </div>
      {!allDay ? (
        <div className="row">
          <span className="muted">to</span>
          <input type="time" step={60} value={toInputTime(end)} disabled={disabled} onChange={(e) => e.target.value && onChange({ start, end: fromInputs(toInputDate(end), e.target.value), allDay })} />
          <span className="muted">{fmtDuration(duration)}</span>
        </div>
      ) : (
        <div className="row">
          <span className="muted">until</span>
          <input type="date" value={toInputDate(new Date(end.getTime() - 1))} disabled={disabled} onChange={(e) => e.target.value && onChange({ start, end: new Date(fromInputs(e.target.value, '00:00').getTime() + 86_400_000), allDay })} />
        </div>
      )}
      {!disabled ? (
        <div className="quick-row">
          <button className="chip" onClick={() => shift(-snap * MIN)} title="Earlier">
            −{snap}m
          </button>
          <button className="chip" onClick={() => shift(snap * MIN)} title="Later">
            +{snap}m
          </button>
          <button className="chip" onClick={() => shift(60 * MIN)}>
            +1h
          </button>
          <button className="chip" onClick={() => shift(24 * 60 * MIN)}>
            +1d
          </button>
          <span className="sep" />
          {[15, 30, 60, 90, 120].map((m) => (
            <button key={m} className={`chip ${duration === m * MIN ? 'on' : ''}`} onClick={() => setDuration(m * MIN)}>
              {fmtDuration(m * MIN)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const RECURRENCE_PRESETS: { id: string; label: string; rule: (start: Date) => string[] | undefined }[] = [
  { id: 'none', label: 'Does not repeat', rule: () => undefined },
  { id: 'daily', label: 'Every day', rule: () => ['RRULE:FREQ=DAILY'] },
  { id: 'weekdays', label: 'Every weekday', rule: () => ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'] },
  { id: 'weekly', label: 'Every week', rule: (s) => [`RRULE:FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][s.getDay()]}`] },
  { id: 'biweekly', label: 'Every 2 weeks', rule: (s) => [`RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][s.getDay()]}`] },
  { id: 'monthly', label: 'Every month (same date)', rule: () => ['RRULE:FREQ=MONTHLY'] },
  { id: 'yearly', label: 'Every year', rule: () => ['RRULE:FREQ=YEARLY'] },
  { id: 'custom', label: 'Custom RRULE…', rule: () => ['RRULE:FREQ=WEEKLY'] },
];

function RecurrenceField({ value, start, onChange, disabled }: { value: string[] | undefined; start: Date; onChange: (v: string[] | undefined) => void; disabled?: boolean }) {
  const presetId = useMemo(() => {
    if (!value?.length) return 'none';
    const match = RECURRENCE_PRESETS.find((p) => p.id !== 'custom' && p.id !== 'none' && JSON.stringify(p.rule(start)) === JSON.stringify(value));
    return match?.id ?? 'custom';
  }, [value, start]);
  const [custom, setCustom] = useState(presetId === 'custom');
  useEffect(() => setCustom(presetId === 'custom'), [presetId]);
  return (
    <div className="field">
      <label>Repeat</label>
      <select
        value={presetId}
        disabled={disabled}
        onChange={(e) => {
          const p = RECURRENCE_PRESETS.find((x) => x.id === e.target.value)!;
          setCustom(p.id === 'custom');
          onChange(p.rule(start));
        }}
      >
        {RECURRENCE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {custom ? (
        <textarea
          className="mono"
          rows={2}
          disabled={disabled}
          value={(value ?? []).join('\n')}
          onChange={(e) => onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))}
          placeholder="RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T000000Z"
        />
      ) : null}
      {value?.length ? <div className="muted small">{describeRecurrence(value)}</div> : null}
    </div>
  );
}

export function TmConfigForm({ value, onChange, disabled }: { value: TmConfig | null; onChange: (v: TmConfig | null) => void; disabled?: boolean }) {
  const defaults = useStore((s) => s.settings.defaultAlert);
  if (!value) {
    return (
      <div className="tm-form off">
        <p className="muted small">Ordinary Google Calendar event: no Time Manager alert.</p>
        <button className="btn" disabled={disabled} onClick={() => onChange(defaultTmConfig({ alert: { ...defaults } }))}>
          Configure for Time Manager
        </button>
      </div>
    );
  }
  const a = value.alert;
  const setAlert = (patch: Partial<AlertPolicy>) => onChange({ ...value, alert: { ...a, ...patch } });
  const presetId = ALERT_PRESETS.find((p) => Object.entries(p.policy).every(([k, v]) => (a as unknown as Record<string, unknown>)[k] === v))?.id ?? 'custom';
  return (
    <div className="tm-form">
      <div className="field">
        <label>Alert</label>
        <select
          value={presetId}
          disabled={disabled}
          onChange={(e) => {
            const p = ALERT_PRESETS.find((x) => x.id === e.target.value);
            if (p) setAlert(p.policy);
            else setAlert({ mode: 'repeat', intervalMin: a.intervalMin || 3, until: 'ack' });
          }}
        >
          {ALERT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom repeat…</option>
        </select>
      </div>
      {a.mode !== 'none' ? (
        <>
          <div className="row">
            <label>Start</label>
            <input type="number" min={-120} max={1440} value={a.leadMin} disabled={disabled} onChange={(e) => setAlert({ leadMin: Number(e.target.value) || 0 })} style={{ width: 70 }} />
            <span className="muted">min before start</span>
          </div>
          {a.mode === 'repeat' ? (
            <>
              <div className="row">
                <label>Every</label>
                <input type="number" min={1} max={720} value={a.intervalMin} disabled={disabled} onChange={(e) => setAlert({ intervalMin: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 70 }} />
                <span className="muted">min</span>
                <select value={a.until} disabled={disabled} onChange={(e) => setAlert({ until: e.target.value as AlertPolicy['until'] })}>
                  <option value="ack">until acknowledged</option>
                  <option value="end">until the event ends</option>
                </select>
              </div>
            </>
          ) : null}
          <div className="row">
            <label>Sound</label>
            <select value={a.sound} disabled={disabled} onChange={(e) => setAlert({ sound: e.target.value as AlertPolicy['sound'] })}>
              <option value="default">Default</option>
              <option value="chime">Chime</option>
              <option value="alarm">Alarm</option>
              <option value="silent">Silent</option>
            </select>
          </div>
        </>
      ) : null}
      <div className="row">
        <label>Tags</label>
        <input type="text" value={value.tags.join(', ')} disabled={disabled} placeholder="deep, errand" onChange={(e) => onChange({ ...value, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
      </div>
      <button className="btn ghost small" disabled={disabled} onClick={() => onChange(null)}>
        Remove Time Manager settings
      </button>
    </div>
  );
}

// ---- create ---------------------------------------------------------------

function CreateForm({ draft: initial }: { draft: Draft }) {
  const allCalendars = useStore((s) => s.calendars);
  const calendars = useMemo(() => allCalendars.filter((c) => ['owner', 'writer'].includes(c.accessRole)), [allCalendars]);
  const { createEvent, closeEditor } = useStore.getState();
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(initial), [initial]);
  const save = async () => {
    setSaving(true);
    await createEvent(draft);
    setSaving(false);
  };
  return (
    <div className="editor-inner">
      <div className="editor-head">
        <h3>New event</h3>
        <button className="btn icon" onClick={closeEditor} title="Close (Esc)">
          ✕
        </button>
      </div>
      <input
        className="title-input"
        autoFocus
        placeholder="Title"
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) void save();
        }}
      />
      <TimeFields start={draft.start} end={draft.end} allDay={draft.allDay} onChange={(t) => setDraft({ ...draft, ...t })} />
      <div className="field">
        <label>Calendar</label>
        <select value={draft.calendarId} onChange={(e) => setDraft({ ...draft, calendarId: e.target.value })}>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summaryOverride ?? c.summary ?? c.id}
            </option>
          ))}
        </select>
      </div>
      <RecurrenceField value={draft.recurrence} start={draft.start} onChange={(recurrence) => setDraft({ ...draft, recurrence })} />
      <div className="field">
        <label>Location</label>
        <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </div>
      <h4>Time Manager</h4>
      <TmConfigForm value={draft.tm} onChange={(tm) => setDraft({ ...draft, tm })} />
      <div className="editor-actions">
        <button className="btn primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Create'}
        </button>
        <button className="btn ghost" onClick={closeEditor}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- edit -----------------------------------------------------------------

function EditForm({ inst: stale }: { inst: EventInstance }) {
  // Re-resolve the instance from the latest cache so edits reflect fresh data.
  const version = useStore((s) => s.version);
  const instancesFor = useStore((s) => s.instancesFor);
  const inst = useMemo(() => {
    const list = instancesFor(new Date(stale.start.getTime() - 86_400_000), new Date(stale.end.getTime() + 86_400_000));
    return list.find((i) => i.key === stale.key) ?? stale;
  }, [version, stale]);
  const { saveDetails, changeTime, configure, unconfigure, remove, closeEditor, toast } = useStore.getState();
  const [title, setTitle] = useState(inst.title === '(No title)' ? '' : inst.title);
  const [location, setLocation] = useState(inst.location ?? '');
  const [description, setDescription] = useState(inst.description ?? '');
  const [recurrence, setRecurrence] = useState<string[] | undefined>(inst.master?.recurrence ?? inst.event.recurrence);
  const [time, setTime] = useState({ start: inst.start, end: inst.end, allDay: inst.allDay });
  const [tm, setTm] = useState<TmConfig | null>(inst.tm);
  const [tmScope, setTmScope] = useState<EditScope>(inst.isRecurring ? 'series' : 'instance');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTitle(inst.title === '(No title)' ? '' : inst.title);
    setLocation(inst.location ?? '');
    setDescription(inst.description ?? '');
    setRecurrence(inst.master?.recurrence ?? inst.event.recurrence);
    setTime({ start: inst.start, end: inst.end, allDay: inst.allDay });
    setTm(inst.tm);
  }, [inst.key, inst.event.etag, inst.master?.etag]);

  const p = inst.permissions;
  const detailsDirty = title !== (inst.title === '(No title)' ? '' : inst.title) || location !== (inst.location ?? '') || description !== (inst.description ?? '') || JSON.stringify(recurrence ?? []) !== JSON.stringify(inst.master?.recurrence ?? inst.event.recurrence ?? []);
  const timeDirty = time.start.getTime() !== inst.start.getTime() || time.end.getTime() !== inst.end.getTime() || time.allDay !== inst.allDay;
  const tmDirty = JSON.stringify(tm) !== JSON.stringify(inst.tm);

  const save = async () => {
    setBusy(true);
    try {
      let scope: EditScope | null = inst.isRecurring ? null : 'instance';
      if ((detailsDirty || timeDirty) && inst.isRecurring) {
        scope = await useStore.getState().askScope(inst, 'Apply changes to');
        if (!scope) return;
      }
      if (timeDirty) {
        const ok = await changeTime(inst, time.start, time.end, time.allDay, scope!);
        if (!ok) return;
      }
      if (detailsDirty) {
        const patch: Parameters<typeof saveDetails>[1] = {};
        if (title !== inst.title) patch.title = title;
        if (location !== (inst.location ?? '')) patch.location = location;
        if (description !== (inst.description ?? '')) patch.description = description;
        const origRec = inst.master?.recurrence ?? inst.event.recurrence ?? [];
        if (JSON.stringify(recurrence ?? []) !== JSON.stringify(origRec)) patch.recurrence = recurrence?.length ? recurrence : null;
        const ok = await saveDetails(inst, patch, patch.recurrence !== undefined ? 'series' : scope!);
        if (!ok) return;
      }
      if (tmDirty) {
        const ok = tm ? await configure(inst, tm, tmScope) : await unconfigure(inst, tmScope);
        if (!ok) return;
      }
      toast('success', 'Saved to Google Calendar');
      closeEditor();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor-inner">
      <div className="editor-head">
        <h3>{p.canEditDetails ? 'Edit event' : 'Event'}</h3>
        <button className="btn icon" onClick={closeEditor} title="Close (Esc)">
          ✕
        </button>
      </div>
      {!p.canEditDetails ? <div className="notice">{p.reason}</div> : null}
      <input className="title-input" placeholder="Title" value={title} disabled={!p.canEditDetails} onChange={(e) => setTitle(e.target.value)} />
      <div className="muted small">
        {inst.calendar.summaryOverride ?? inst.calendar.summary}
        {inst.isRecurring ? ' · recurring' : ''}
        {inst.isException ? ' (modified occurrence)' : ''}
        {inst.event.htmlLink ? (
          <>
            {' · '}
            <a href={inst.event.htmlLink} target="_blank" rel="noreferrer">
              open in Google Calendar
            </a>
          </>
        ) : null}
      </div>
      <TimeFields start={time.start} end={time.end} allDay={time.allDay} disabled={!p.canEditDetails} onChange={setTime} />
      <RecurrenceField value={recurrence} start={time.start} disabled={!p.canEditDetails} onChange={setRecurrence} />
      <div className="field">
        <label>Location</label>
        <input value={location} disabled={!p.canEditDetails} onChange={(e) => setLocation(e.target.value)} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={3} value={description} disabled={!p.canEditDetails} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {inst.event.attendees?.length ? (
        <div className="field">
          <label>Guests</label>
          <div className="muted small">{inst.event.attendees.map((a) => `${a.displayName ?? a.email}${a.organizer ? ' (organizer)' : ''}${a.responseStatus ? ` · ${a.responseStatus}` : ''}`).join(', ')}</div>
        </div>
      ) : null}
      <h4>
        Time Manager
        {inst.tmSource === 'series' ? <span className="muted small"> · from series</span> : null}
        {inst.tmSource === 'instance' && inst.isRecurring ? <span className="muted small"> · this occurrence</span> : null}
      </h4>
      {!p.canConfigure ? (
        <div className="notice">
          {p.reason} Time Manager settings cannot be attached. A future "Create configurable copy" feature could make a private copy you
          control.
        </div>
      ) : (
        <>
          <TmConfigForm value={tm} onChange={setTm} />
          {inst.isRecurring && tmDirty ? (
            <div className="row">
              <label>Apply to</label>
              <select value={tmScope} onChange={(e) => setTmScope(e.target.value as EditScope)}>
                <option value="series">all events in the series (recommended)</option>
                <option value="instance">this occurrence only</option>
              </select>
            </div>
          ) : null}
        </>
      )}
      <div className="editor-actions">
        <button className="btn primary" disabled={busy || (!detailsDirty && !timeDirty && !tmDirty)} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" onClick={closeEditor}>
          Cancel
        </button>
        {p.canDelete ? (
          <button className="btn danger" disabled={busy} onClick={() => void remove(inst)}>
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}
