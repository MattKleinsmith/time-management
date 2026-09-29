import { create } from 'zustand';
import {
  buildInstances,
  currentInstance,
  defaultTmConfig,
  deviceTimeZone,
  emptyLocalAlertState,
  EventOperations,
  nextInstance,
  ReadOnlyEventError,
  SyncEngine,
  type EditScope,
  type EventDraft,
  type EventInstance,
  type GcalCalendarListEntry,
  type GcalClient,
  type LocalAlertState,
  type TmConfig,
} from '@tm/core';
import { createClient, fetchMe, isMockMode, type Me } from './api';
import { IdbPersistence, KEYS, kvGet, kvSet, loadLocalAlerts, MemoryPersistenceIfMock, pruneLocalAlerts, saveLocalAlerts } from './persistence';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from './settings';
import { setTimeFormat } from './format';

export type ViewMode = 'week' | 'day' | 'now' | 'agenda' | 'settings';

export interface Draft {
  calendarId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  description: string;
  location: string;
  recurrence: string[] | undefined;
  tm: TmConfig | null;
  colorId?: string;
}

export type EditorState = { mode: 'create'; draft: Draft } | { mode: 'edit'; instanceKey: string; instance: EventInstance } | null;

export interface ScopePrompt {
  title: string;
  message?: string;
  allowFollowing: boolean;
  resolve: (scope: EditScope | null) => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface DragPreview {
  key: string;
  start: Date;
  end: Date;
}

interface State {
  status: 'booting' | 'unauthenticated' | 'ready' | 'error';
  error?: string;
  me: Me | null;
  client: GcalClient | null;
  engine: SyncEngine | null;
  ops: EventOperations | null;
  version: number;
  calendars: GcalCalendarListEntry[];
  syncing: boolean;
  lastSyncAt: Date | null;
  syncError: string | null;
  localAlerts: LocalAlertState;
  settings: Settings;
  view: ViewMode;
  anchor: Date;
  selectedKey: string | null;
  editor: EditorState;
  scopePrompt: ScopePrompt | null;
  toasts: Toast[];
  now: Date;
  dragPreview: DragPreview | null;
  helpOpen: boolean;
  searchQuery: string;
  notificationPermission: NotificationPermission | 'unsupported';
  audioUnlocked: boolean;
  timeZone: string;

  boot(): Promise<void>;
  sync(reason?: string): Promise<void>;
  resetCache(): Promise<void>;
  setSettings(patch: Partial<Settings>): void;
  setView(view: ViewMode): void;
  setAnchor(d: Date): void;
  navigate(delta: number): void;
  goToday(): void;
  select(key: string | null): void;
  openCreate(draft?: Partial<Draft>): void;
  openEdit(inst: EventInstance): void;
  closeEditor(): void;
  askScope(inst: EventInstance, title: string, allowFollowing?: boolean): Promise<EditScope | null>;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  setDragPreview(p: DragPreview | null): void;
  toggleHelp(): void;
  setSearch(q: string): void;
  setNotificationPermission(p: NotificationPermission | 'unsupported'): void;
  setAudioUnlocked(v: boolean): void;
  updateLocalAlerts(next: LocalAlertState): void;
  tickNow(): void;
  focusInstance(key: string): void;

  // Domain commands
  createEvent(draft: Draft): Promise<void>;
  saveDetails(inst: EventInstance, patch: { title?: string; description?: string; location?: string; colorId?: string; recurrence?: string[] | null }, scope?: EditScope): Promise<boolean>;
  changeTime(inst: EventInstance, start: Date, end: Date, allDay?: boolean, scope?: EditScope): Promise<boolean>;
  configure(inst: EventInstance, cfg: TmConfig, scope?: EditScope): Promise<boolean>;
  unconfigure(inst: EventInstance, scope?: EditScope): Promise<boolean>;
  remove(inst: EventInstance, scope?: EditScope): Promise<boolean>;
  acknowledge(inst: EventInstance): Promise<void>;
  snooze(inst: EventInstance, minutes: number): Promise<void>;
  instancesFor(start: Date, end: Date): EventInstance[];
}

let toastId = 0;
let syncTimer: ReturnType<typeof setInterval> | null = null;
const instanceCache = new Map<string, EventInstance[]>();

function keyOf(version: number, start: Date, end: Date, visible: string | null) {
  return `${version}:${start.getTime()}:${end.getTime()}:${visible ?? '*'}`;
}

export const useStore = create<State>((set, get) => ({
  status: 'booting',
  me: null,
  client: null,
  engine: null,
  ops: null,
  version: 0,
  calendars: [],
  syncing: false,
  lastSyncAt: null,
  syncError: null,
  localAlerts: emptyLocalAlertState(),
  settings: DEFAULT_SETTINGS,
  view: typeof window !== 'undefined' && window.innerWidth < 768 ? 'now' : 'week',
  anchor: startOfView(new Date(), DEFAULT_SETTINGS),
  selectedKey: null,
  editor: null,
  scopePrompt: null,
  toasts: [],
  now: new Date(),
  dragPreview: null,
  helpOpen: false,
  searchQuery: '',
  notificationPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  audioUnlocked: false,
  timeZone: deviceTimeZone(),

  async boot() {
    try {
      const saved = await kvGet<Partial<Settings>>(KEYS.settings);
      const settings = mergeSettings(saved);
      setTimeFormat(settings.timeFormat);
      const localAlerts = pruneLocalAlerts(await loadLocalAlerts());
      set({ settings, localAlerts, anchor: startOfView(new Date(), settings) });
      const me = await fetchMe();
      if (!me) {
        set({ status: 'unauthenticated', me: null });
        return;
      }
      const client = createClient(() => set({ status: 'unauthenticated' }));
      const engine = new SyncEngine(client, isMockMode() ? new MemoryPersistenceIfMock() : new IdbPersistence());
      await engine.load();
      const ops = new EventOperations({
        client,
        engine,
        localAlerts: {
          get: () => get().localAlerts,
          set: (next) => get().updateLocalAlerts(next),
        },
      });
      set({
        status: 'ready',
        me,
        client,
        engine,
        ops,
        calendars: Object.values(engine.snapshot.calendars).map((c) => c.calendar),
        version: get().version + 1,
      });
      void get().sync('boot');
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void get().sync('interval');
      }, Math.max(30, settings.syncIntervalSec) * 1000);
    } catch (e) {
      console.error(e);
      set({ status: 'error', error: (e as Error).message });
    }
  },

  async sync(reason) {
    const { engine, syncing, settings } = get();
    if (!engine || syncing) return;
    set({ syncing: true, syncError: null });
    try {
      const result = await engine.sync({
        onProgress: () => set({ version: get().version + 1, calendars: Object.values(engine.snapshot.calendars).map((c) => c.calendar) }),
      });
      const calendars = result.calendars.filter((c) => !c.deleted);
      set({ calendars, lastSyncAt: new Date(), version: get().version + 1 });
      if (result.errors.length) {
        const first = result.errors[0].error as Error;
        set({ syncError: `${result.errors[0].calendarId}: ${first?.message ?? String(first)}` });
        if ((first as { status?: number }).status === 401) set({ status: 'unauthenticated' });
      }
      if (reason === 'manual') get().toast('success', 'Synced with Google Calendar');
      void settings;
    } catch (e) {
      set({ syncError: (e as Error).message });
      if ((e as { status?: number }).status === 401) set({ status: 'unauthenticated' });
    } finally {
      set({ syncing: false });
    }
  },

  async resetCache() {
    const { engine } = get();
    if (!engine) return;
    await engine.reset();
    set({ version: get().version + 1 });
    await get().sync('manual');
  },

  setSettings(patch) {
    const settings = { ...get().settings, ...patch };
    setTimeFormat(settings.timeFormat);
    set({ settings, version: get().version + 1 });
    void kvSet(KEYS.settings, settings);
    if (patch.syncIntervalSec && syncTimer) {
      clearInterval(syncTimer);
      syncTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void get().sync('interval');
      }, Math.max(30, settings.syncIntervalSec) * 1000);
    }
  },

  setView(view) {
    set({ view, helpOpen: false });
  },
  setAnchor(d) {
    set({ anchor: d });
  },
  navigate(delta) {
    const { view, anchor, settings } = get();
    const days = view === 'day' ? 1 : view === 'week' ? settings.daysInView : 1;
    const d = new Date(anchor);
    d.setDate(d.getDate() + delta * days);
    set({ anchor: d });
  },
  goToday() {
    const { view, settings } = get();
    set({ anchor: view === 'week' ? startOfView(new Date(), settings) : startOfLocalDay(new Date()) });
  },
  select(key) {
    set({ selectedKey: key });
  },

  openCreate(partial) {
    const { settings, calendars, timeZone } = get();
    const writable = calendars.filter((c) => ['owner', 'writer'].includes(c.accessRole));
    const defaultCal = writable.find((c) => c.id === settings.defaultCalendarId) ?? writable.find((c) => c.primary) ?? writable[0];
    const start = partial?.start ?? roundUp(new Date(), settings.snapMinutes);
    const end = partial?.end ?? new Date(start.getTime() + settings.defaultDurationMin * 60_000);
    const draft: Draft = {
      calendarId: partial?.calendarId ?? defaultCal?.id ?? 'primary',
      title: partial?.title ?? '',
      start,
      end,
      allDay: partial?.allDay ?? false,
      description: partial?.description ?? '',
      location: partial?.location ?? '',
      recurrence: partial?.recurrence,
      tm: partial?.tm !== undefined ? partial.tm : settings.autoConfigureNewEvents ? defaultTmConfig({ alert: { ...settings.defaultAlert } }) : null,
    };
    void timeZone;
    set({ editor: { mode: 'create', draft }, selectedKey: null });
  },
  openEdit(inst) {
    set({ editor: { mode: 'edit', instanceKey: inst.key, instance: inst }, selectedKey: inst.key });
  },
  closeEditor() {
    set({ editor: null });
  },

  askScope(inst, title, allowFollowing = true) {
    if (!inst.isRecurring) return Promise.resolve('instance' as EditScope);
    return new Promise<EditScope | null>((resolve) => {
      set({
        scopePrompt: {
          title,
          allowFollowing,
          resolve: (scope) => {
            set({ scopePrompt: null });
            resolve(scope);
          },
        },
      });
    });
  },

  toast(kind, text) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 3500);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setDragPreview(p) {
    set({ dragPreview: p });
  },
  toggleHelp() {
    set({ helpOpen: !get().helpOpen });
  },
  setSearch(q) {
    set({ searchQuery: q });
  },
  setNotificationPermission(p) {
    set({ notificationPermission: p });
  },
  setAudioUnlocked(v) {
    set({ audioUnlocked: v });
  },
  updateLocalAlerts(next) {
    set({ localAlerts: next, version: get().version + 1 });
    void saveLocalAlerts(next);
  },
  tickNow() {
    set({ now: new Date() });
  },
  focusInstance(key) {
    const now = new Date();
    const list = get().instancesFor(startOfLocalDay(new Date(now.getTime() - 2 * 86_400_000)), new Date(now.getTime() + 3 * 86_400_000));
    const inst = list.find((i) => i.key === key);
    if (inst) {
      set({ view: isNarrow() ? 'now' : get().view === 'settings' ? 'week' : get().view });
      get().openEdit(inst);
    }
  },

  async createEvent(draft) {
    const { ops, timeZone } = get();
    if (!ops) return;
    try {
      const d: EventDraft = {
        calendarId: draft.calendarId,
        title: draft.title.trim() || '(No title)',
        start: draft.start,
        end: draft.end,
        allDay: draft.allDay,
        timeZone,
        description: draft.description || undefined,
        location: draft.location || undefined,
        recurrence: draft.recurrence,
        tm: draft.tm,
        colorId: draft.colorId,
      };
      await ops.createEvent(d);
      bump(set, get);
      set({ editor: null });
      get().toast('success', 'Event created in Google Calendar');
    } catch (e) {
      get().toast('error', `Could not create event: ${(e as Error).message}`);
    }
  },

  async saveDetails(inst, patch, scope) {
    const { ops } = get();
    if (!ops) return false;
    try {
      const s = scope ?? (await get().askScope(inst, 'Apply changes to'));
      if (!s) return false;
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.summary = patch.title;
      if (patch.description !== undefined) body.description = patch.description;
      if (patch.location !== undefined) body.location = patch.location;
      if (patch.colorId !== undefined) body.colorId = patch.colorId || null;
      if (patch.recurrence !== undefined) body.recurrence = patch.recurrence;
      await ops.updateDetails(inst, body, s);
      bump(set, get);
      return true;
    } catch (e) {
      handleError(get, e);
      return false;
    }
  },

  async changeTime(inst, start, end, allDay, scope) {
    const { ops } = get();
    if (!ops) return false;
    if (!inst.permissions.canEditDetails) {
      get().toast('error', inst.permissions.reason ?? 'This event cannot be modified.');
      return false;
    }
    try {
      const s = scope ?? (await get().askScope(inst, 'Move this event for'));
      if (!s) return false;
      await ops.changeTime(inst, { start, end, allDay }, s);
      bump(set, get);
      return true;
    } catch (e) {
      handleError(get, e);
      return false;
    }
  },

  async configure(inst, cfg, scope) {
    const { ops } = get();
    if (!ops) return false;
    if (!inst.permissions.canConfigure) {
      get().toast(
        'error',
        `${inst.permissions.reason ?? 'This event cannot be modified.'} "Create configurable copy" is a planned feature.`,
      );
      return false;
    }
    try {
      const s = scope ?? (await get().askScope(inst, 'Configure Time Manager for', false));
      if (!s) return false;
      await ops.setTmConfig(inst, cfg, s);
      bump(set, get);
      return true;
    } catch (e) {
      handleError(get, e);
      return false;
    }
  },

  async unconfigure(inst, scope) {
    const { ops } = get();
    if (!ops) return false;
    try {
      const s = scope ?? (await get().askScope(inst, 'Remove Time Manager settings from', false));
      if (!s) return false;
      await ops.clearTmConfig(inst, s);
      bump(set, get);
      return true;
    } catch (e) {
      handleError(get, e);
      return false;
    }
  },

  async remove(inst, scope) {
    const { ops } = get();
    if (!ops) return false;
    if (!inst.permissions.canDelete) {
      get().toast('error', inst.permissions.reason ?? 'This event cannot be deleted.');
      return false;
    }
    try {
      const s = scope ?? (await get().askScope(inst, 'Delete'));
      if (!s) return false;
      await ops.deleteEvent(inst, s);
      bump(set, get);
      set({ editor: null, selectedKey: null });
      get().toast('success', 'Deleted');
      return true;
    } catch (e) {
      handleError(get, e);
      return false;
    }
  },

  async acknowledge(inst) {
    const { ops } = get();
    if (!ops) return;
    try {
      await ops.acknowledge(inst);
      bump(set, get);
    } catch (e) {
      handleError(get, e);
    }
  },

  async snooze(inst, minutes) {
    const { ops } = get();
    if (!ops) return;
    try {
      await ops.snooze(inst, minutes);
      bump(set, get);
      get().toast('info', `Snoozed ${minutes} min`);
    } catch (e) {
      handleError(get, e);
    }
  },

  instancesFor(start, end) {
    const { engine, version, settings, timeZone, calendars } = get();
    if (!engine) return [];
    const visible = settings.visibleCalendarIds;
    const k = keyOf(version, start, end, visible ? visible.join(',') : null);
    const cached = instanceCache.get(k);
    if (cached) return cached;
    const snaps = engine.getCalendarSnapshots().filter((s) => {
      if (visible) return visible.includes(s.calendar.id);
      const c = calendars.find((x) => x.id === s.calendar.id) ?? s.calendar;
      return c.selected !== false;
    });
    const list = buildInstances(snaps, { windowStart: start, windowEnd: end, timeZone });
    if (instanceCache.size > 40) instanceCache.clear();
    instanceCache.set(k, list);
    return list;
  },
}));

function bump(set: (p: Partial<State>) => void, get: () => State) {
  set({ version: get().version + 1 });
}

function handleError(get: () => State, e: unknown) {
  if (e instanceof ReadOnlyEventError) {
    get().toast('error', e.message);
    return;
  }
  console.error(e);
  const status = (e as { status?: number }).status;
  if (status === 401) get().toast('error', 'Google session expired. Please sign in again.');
  else get().toast('error', (e as Error).message ?? String(e));
}

export function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function startOfView(d: Date, settings: Settings): Date {
  const x = startOfLocalDay(d);
  if (settings.daysInView === 7) {
    const diff = (x.getDay() - settings.weekStartsOn + 7) % 7;
    x.setDate(x.getDate() - diff);
  }
  return x;
}

function roundUp(d: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

/** Helpers used by views. */
export function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 768;
}

export function viewRange(state: Pick<State, 'view' | 'anchor' | 'settings'>): { start: Date; end: Date; days: number } {
  const configured = isNarrow() ? Math.min(state.settings.daysInView, 3) : state.settings.daysInView;
  const days = state.view === 'day' ? 1 : state.view === 'week' ? configured : 1;
  const start = startOfLocalDay(state.anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { start, end, days };
}

export function useCurrentAndNext(now: Date) {
  const instancesFor = useStore((s) => s.instancesFor);
  const version = useStore((s) => s.version);
  void version;
  const start = new Date(now.getTime() - 36 * 3600_000);
  const end = new Date(now.getTime() + 7 * 86_400_000);
  const list = instancesFor(startOfLocalDay(start), end);
  return { current: currentInstance(list, now), next: nextInstance(list, now), list };
}
