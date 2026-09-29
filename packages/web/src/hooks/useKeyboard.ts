import { useEffect } from 'react';
import { useStore, viewRange } from '../lib/store';
import { computePlan } from '../lib/delivery';
import { matchesSearch } from '../components/WeekView';

const STEP = 15 * 60_000;

export function useKeyboard() {
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const s = useStore.getState();
      if (e.key === 'Escape') {
        if (s.scopePrompt) return s.scopePrompt.resolve(null);
        if (s.helpOpen) return s.toggleHelp();
        if (s.editor) return s.closeEditor();
        if (typing) return (target as HTMLElement).blur();
        return s.select(null);
      }
      if (typing || s.scopePrompt || s.status !== 'ready') return;
      if (e.metaKey || e.ctrlKey) return;
      const range = viewRange(s);
      const list = () => s.instancesFor(range.start, range.end).filter((i) => matchesSearch(i, s.searchQuery));
      const selected = () => (s.selectedKey ? list().find((i) => i.key === s.selectedKey) : undefined);
      switch (e.key) {
        case '?':
          s.toggleHelp();
          break;
        case 'n':
          s.openCreate();
          break;
        case 't':
          s.goToday();
          break;
        case 'ArrowLeft':
          s.navigate(-1);
          break;
        case 'ArrowRight':
          s.navigate(1);
          break;
        case 'd':
          s.setView('day');
          break;
        case 'w':
          s.setView('week');
          break;
        case 'g':
          s.setView('agenda');
          break;
        case 'h':
          s.setView('now');
          break;
        case ',':
          s.setView('settings');
          break;
        case 'r':
          void s.sync('manual');
          break;
        case '/':
          e.preventDefault();
          (document.querySelector('input.search') as HTMLInputElement | null)?.focus();
          break;
        case '+':
        case '=':
          s.setSettings({ pxPerHour: Math.min(200, s.settings.pxPerHour + 8) });
          break;
        case '-':
          s.setSettings({ pxPerHour: Math.max(24, s.settings.pxPerHour - 8) });
          break;
        case 'j':
        case 'k': {
          const items = list().filter((i) => !i.allDay);
          if (!items.length) break;
          const idx = items.findIndex((i) => i.key === s.selectedKey);
          const next = e.key === 'j' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
          s.select(items[next].key);
          document.querySelector(`.event.selected`)?.scrollIntoView({ block: 'nearest' });
          break;
        }
        case 'Enter': {
          const inst = selected();
          if (inst) s.openEdit(inst);
          break;
        }
        case 'Delete':
        case 'Backspace': {
          const inst = selected();
          if (inst) void s.remove(inst);
          break;
        }
        case '[':
        case ']': {
          const inst = selected();
          if (!inst) break;
          const dir = e.key === ']' ? 1 : -1;
          if (e.shiftKey) {
            const end = new Date(inst.end.getTime() + dir * STEP);
            if (end.getTime() > inst.start.getTime()) void s.changeTime(inst, inst.start, end);
          } else {
            void s.changeTime(inst, new Date(inst.start.getTime() + dir * STEP), new Date(inst.end.getTime() + dir * STEP));
          }
          break;
        }
        case 'a':
        case 's': {
          const plan = computePlan(new Date());
          const first = plan.active[0];
          if (!first) break;
          if (e.key === 'a') void s.acknowledge(first.instance);
          else void s.snooze(first.instance, 5);
          break;
        }
        default:
          if (/^[1-9]$/.test(e.key)) {
            s.setSettings({ daysInView: Number(e.key) });
            s.setView('week');
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
