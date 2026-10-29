// FR-LOOP-006: Tools › Loop — the loop list and the loop editor (docs/design/loop-scheduler.html).
import { useCallback, useEffect, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Button, Field, NumberInput, Select, Switch, TextInput } from '../ui';
import { activeLanguage, t, tn } from '../../i18n/i18n.ts';
import { loopApi, sessionApi } from '../../services/api.ts';
import type { ShellInfo } from '../../types';
import { appendSteps, canAddStep, localDate, moveStep, newLoopDraft, numberField, parseLoopLine } from './loopModel.ts';
import { DAY_KEYS, MODE_KEYS, RESULT_KEYS, RUN_REASON_KEYS, STEP_KEYS } from './loopMessages.ts';
import type { LoopInput, LoopRun, LoopSchedule, LoopStep, LoopView } from './loopTypes.ts';
import './LoopDialog.css';

interface LoopDialogProps {
  onClose: () => void;
  /** The active tab's folder, offered to a new loop. */
  defaultCwd?: string | null;
  /** AC-1: the Tools menu shows how many loops are on. */
  onEnabledCountChange?: (count: number) => void;
}

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function LoopDialog({ onClose, defaultCwd, onEnabledCountChange }: LoopDialogProps) {
  const [loops, setLoops] = useState<LoopView[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: LoopInput } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, LoopRun[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await loopApi.list();
      setLoops(list);
      onEnabledCountChange?.(list.filter((loop) => loop.enabled).length);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [onEnabledCountChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A run answers at once (202), so the list follows it until no run is left running.
  const anyRunning = loops?.some((loop) => loop.lastRun?.result === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = window.setTimeout(() => {
      void refresh();
      if (expanded) void loadRuns(expanded);
    }, 3000);
    return () => window.clearTimeout(timer);
  });

  const loadRuns = async (id: string) => {
    try {
      const history = await loopApi.history(id);
      setRuns((current) => ({ ...current, [id]: history }));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const toggle = async (loop: LoopView) => {
    setError(null);
    try {
      await loopApi.save(loop.id, { ...toInput(loop), enabled: !loop.enabled });
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const runNow = async (loop: LoopView) => {
    setError(null);
    setBusy(loop.id);
    try {
      await loopApi.runNow(loop.id);
      await refresh();
      if (expanded === loop.id) await loadRuns(loop.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };

  const expand = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) void loadRuns(next);
  };

  return (
    <WindowDialog
      dialogId="loop-manager"
      title={editing ? t(editing.id === null ? 'loop.editor.newTitle' : 'loop.editor.editTitle') : t('loop.title')}
      mode="modal"
      defaultRect={{ x: 120, y: 70, width: 860, height: 640 }}
      minSize={{ width: 420, height: 420 }}
      onClose={onClose}
    >
      {editing ? (
        <LoopEditor
          id={editing.id}
          initial={editing.draft}
          onCancel={() => setEditing(null)}
          onDone={async () => { setEditing(null); await refresh(); }}
        />
      ) : (
        <div className="loop-dialog" data-testid="loop-dialog">
          <div className="loop-toolbar">
            <Button variant="primary" size="md" icon="plus" onClick={() => setEditing({ id: null, draft: { ...newLoopDraft(new Date()), cwd: defaultCwd ?? '' } })}>
              {t('loop.new')}
            </Button>
            <span className="loop-help">{t('loop.help')}</span>
          </div>
          {error !== null && <div className="loop-error" role="alert">{error}</div>}
          <div className="loop-list" role="list">
            {loops !== null && loops.length === 0 && <div className="loop-empty">{t('loop.empty')}</div>}
            {loops?.map((loop) => (
              <div key={loop.id} role="listitem" className={`loop-row${loop.enabled ? '' : ' loop-row-off'}`}>
                <div className="loop-row-main">
                  <Switch checked={loop.enabled} aria-label={t('loop.enabled')} onChange={() => void toggle(loop)} />
                  <button type="button" className="loop-row-text" aria-expanded={expanded === loop.id} onClick={() => expand(loop.id)}>
                    <span className="loop-name">{loop.name}</span>
                    <span className="loop-sub">{scheduleSummary(loop.schedule)} · {loop.shell} · <span className="loop-mono">{loop.cwd}</span> · {tn('loop.stepCount', loop.steps.length)}</span>
                  </button>
                  <span className="loop-next">
                    <span className="loop-col-label">{t('loop.col.next')}</span>
                    {loop.enabled ? (loop.nextRunAt ? formatTime(loop.nextRunAt) : t('loop.next.none')) : t('loop.next.off')}
                  </span>
                  <span className={`loop-result loop-result-${loop.lastRun?.result ?? 'never'}`}>
                    <span className="loop-col-label">{t('loop.col.last')}</span>
                    {loop.lastRun ? `${t(RESULT_KEYS[loop.lastRun.result])} · ${formatTime(loop.lastRun.startedAt)}` : t('loop.result.never')}
                  </span>
                  <span className="loop-row-actions">
                    <Button size="sm" variant="secondary" disabled={busy === loop.id} onClick={() => void runNow(loop)}>{t('loop.runNow')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ id: loop.id, draft: toInput(loop) })}>{t('loop.edit')}</Button>
                  </span>
                </div>
                {expanded === loop.id && <RunHistory runs={runs[loop.id]} />}
              </div>
            ))}
          </div>
          <div className="loop-actions">
            <Button variant="secondary" size="md" onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      )}
    </WindowDialog>
  );
}

function RunHistory({ runs }: { runs: LoopRun[] | undefined }) {
  if (runs === undefined) return null;
  if (runs.length === 0) return <div className="loop-history loop-empty">{t('loop.history.empty')}</div>;
  return (
    <table className="loop-history">
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>{formatTime(run.startedAt)}</td>
            <td className={`loop-result-${run.result}`}>{t(RESULT_KEYS[run.result])}</td>
            <td>{run.workspaceName ? `${run.workspaceName} · ${run.tabName ?? ''}` : ''}</td>
            <td>{t('loop.history.steps', { sent: run.stepsSent, total: run.totalSteps })}</td>
            <td className="loop-history-reason">{run.reason ? t(RUN_REASON_KEYS[run.reason], { detail: run.detail ?? '' }) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const INTERVAL_PRESETS = [10, 20, 30, 60, 120, 360] as const;

function LoopEditor({ id, initial, onCancel, onDone }: { id: string | null; initial: LoopInput; onCancel: () => void; onDone: () => Promise<void> }) {
  const [draft, setDraft] = useState<LoopInput>(initial);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [newTime, setNewTime] = useState('');
  const [quick, setQuick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    sessionApi.getShells().then(setShells).catch(() => setShells([]));
  }, []);

  const patch = (changes: Partial<LoopInput>) => setDraft((current) => ({ ...current, ...changes }));
  const setSchedule = (schedule: LoopSchedule) => patch({ schedule });
  const setSteps = (steps: LoopStep[]) => patch({ steps });
  const schedule = draft.schedule;
  const times = schedule.kind === 'interval' ? [] : schedule.times;

  const switchMode = (kind: LoopSchedule['kind']) => {
    if (kind === schedule.kind) return;
    const kept = times.length > 0 ? times : ['09:00'];
    const today = localDate(new Date());
    setSchedule(
      kind === 'weekly' ? { kind, days: [1, 2, 3, 4, 5], times: kept }
        : kind === 'monthly' ? { kind, dates: [1], lastDay: false, times: kept }
          : kind === 'once' ? { kind, date: today, times: kept }
            : { kind, everyMinutes: 30, startsAt: `${today}T${kept[0]}` },
    );
  };

  const setTimes = (next: string[]) => {
    if (schedule.kind !== 'interval') setSchedule({ ...schedule, times: [...new Set(next)].sort() });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await loopApi.save(id, draft);
      await onDone();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (id === null || !window.confirm(t('loop.delete.confirm', { name: draft.name }))) return;
    try {
      await loopApi.remove(id);
      await onDone();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const addQuick = () => {
    const parsed = parseLoopLine(quick);
    if (parsed.length === 0) return;
    setSteps(appendSteps(draft.steps, parsed));
    setQuick('');
  };

  return (
    <div className="loop-dialog loop-editor" data-testid="loop-editor">
      <div className="loop-editor-body">
        <Field label={t('loop.field.name')} htmlFor="loop-name">
          <TextInput id="loop-name" value={draft.name} maxLength={64} onChange={(e) => patch({ name: e.target.value })} />
        </Field>

        <div className="loop-section">{t('loop.section.when')}</div>
        <Field label={t('loop.field.repeat')}>
          <div className="loop-seg" role="group">
            {(Object.keys(MODE_KEYS) as Array<LoopSchedule['kind']>).map((kind) => (
              <button key={kind} type="button" aria-pressed={schedule.kind === kind} onClick={() => switchMode(kind)}>{t(MODE_KEYS[kind])}</button>
            ))}
          </div>
        </Field>

        {schedule.kind === 'weekly' && (
          <Field label={t('loop.field.days')}>
            <div className="loop-days">
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <button key={day} type="button" className="loop-day" aria-pressed={schedule.days.includes(day)}
                  onClick={() => setSchedule({ ...schedule, days: toggleNumber(schedule.days, day) })}>
                  {t(DAY_KEYS[day])}
                </button>
              ))}
              <span className="loop-day-presets">
                <button type="button" onClick={() => setSchedule({ ...schedule, days: [1, 2, 3, 4, 5] })}>{t('loop.days.weekdays')}</button>
                <button type="button" onClick={() => setSchedule({ ...schedule, days: [0, 6] })}>{t('loop.days.weekend')}</button>
                <button type="button" onClick={() => setSchedule({ ...schedule, days: [0, 1, 2, 3, 4, 5, 6] })}>{t('loop.days.everyday')}</button>
              </span>
            </div>
          </Field>
        )}

        {schedule.kind === 'monthly' && (
          <Field label={t('loop.field.dates')} help={t('loop.dates.help')}>
            <div className="loop-month">
              {Array.from({ length: 31 }, (_, i) => i + 1).map((date) => (
                <button key={date} type="button" aria-pressed={schedule.dates.includes(date)}
                  onClick={() => setSchedule({ ...schedule, dates: toggleNumber(schedule.dates, date) })}>{date}</button>
              ))}
              <button type="button" className="loop-month-last" aria-pressed={schedule.lastDay}
                onClick={() => setSchedule({ ...schedule, lastDay: !schedule.lastDay })}>{t('loop.dates.last')}</button>
            </div>
          </Field>
        )}

        {schedule.kind === 'once' && (
          <Field label={t('loop.field.date')} htmlFor="loop-date" help={t('loop.once.help')}>
            <TextInput id="loop-date" type="date" value={schedule.date} onChange={(e) => setSchedule({ ...schedule, date: e.target.value })} />
          </Field>
        )}

        {schedule.kind !== 'interval' ? (
          <Field label={t('loop.field.times')} htmlFor="loop-time-new">
            <div className="loop-times">
              {schedule.times.map((time) => (
                <span key={time} className="loop-chip">
                  {time}
                  <button type="button" aria-label={t('loop.times.remove', { time })} onClick={() => setTimes(schedule.times.filter((x) => x !== time))}>✕</button>
                </span>
              ))}
              <TextInput id="loop-time-new" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
              <Button size="sm" variant="secondary" disabled={!newTime} onClick={() => { setTimes([...schedule.times, newTime]); setNewTime(''); }}>{t('loop.times.add')}</Button>
            </div>
          </Field>
        ) : (
          <>
            <Field label={t('loop.field.every')}>
              <div className="loop-seg" role="group">
                {INTERVAL_PRESETS.map((minutes) => (
                  <button key={minutes} type="button" aria-pressed={schedule.everyMinutes === minutes}
                    onClick={() => setSchedule({ ...schedule, everyMinutes: minutes })}>{intervalLabel(minutes)}</button>
                ))}
              </div>
              <NumberInput min={1} value={Number.isNaN(schedule.everyMinutes) ? '' : schedule.everyMinutes} unit={t('loop.unit.minutes')} aria-label={t('loop.field.every')}
                onChange={(e) => setSchedule({ ...schedule, everyMinutes: numberField(e.target.value) })} />
            </Field>
            <Field label={t('loop.field.startsAt')} htmlFor="loop-starts" help={t('loop.interval.help')}>
              <TextInput id="loop-starts" type="datetime-local" value={schedule.startsAt} onChange={(e) => setSchedule({ ...schedule, startsAt: e.target.value })} />
            </Field>
          </>
        )}

        <div className="loop-section">{t('loop.section.where')}</div>
        <Field label={t('loop.field.shell')} htmlFor="loop-shell">
          <Select id="loop-shell" value={draft.shell} onChange={(e) => patch({ shell: e.target.value as LoopInput['shell'] })}>
            <option value="auto">{t('loop.shell.auto')}</option>
            {shells.filter((shell) => shell.id !== 'auto').map((shell) => <option key={shell.id} value={shell.id}>{shell.label}</option>)}
            {draft.shell !== 'auto' && !shells.some((shell) => shell.id === draft.shell) && <option value={draft.shell}>{draft.shell}</option>}
          </Select>
        </Field>
        <Field label={t('loop.field.cwd')} htmlFor="loop-cwd" help={t('loop.cwd.help')}>
          <TextInput id="loop-cwd" mono value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
        </Field>
        <Field label={t('loop.field.keepTabs')} htmlFor="loop-keep" help={t('loop.keepTabs.help')}>
          <NumberInput id="loop-keep" min={1} max={16} value={Number.isNaN(draft.keepTabs) ? '' : draft.keepTabs} onChange={(e) => patch({ keepTabs: numberField(e.target.value) })} />
        </Field>

        <div className="loop-section">{t('loop.section.what')}</div>
        <div className="loop-steps">
          {draft.steps.length === 0 && <div className="loop-empty">{t('loop.steps.empty')}</div>}
          {draft.steps.map((step, index) => (
            <StepRow
              key={index}
              step={step}
              index={index}
              steps={draft.steps}
              onChange={(next) => setSteps(draft.steps.map((current, i) => (i === index ? next : current)))}
              onMove={(by) => setSteps(moveStep(draft.steps, index, by))}
              onRemove={() => setSteps(draft.steps.filter((_, i) => i !== index))}
            />
          ))}
        </div>
        {canAddStep(draft.steps) ? (
          <>
            <div className="loop-adders">
              {(Object.keys(STEP_KEYS) as Array<LoopStep['kind']>).map((kind) => (
                <button key={kind} type="button" className={`loop-adder loop-kind-${kind}`} onClick={() => setSteps(appendSteps(draft.steps, [emptyStep(kind)]))}>
                  + {t(STEP_KEYS[kind])}
                </button>
              ))}
            </div>
            <div className="loop-quick">
              <TextInput mono value={quick} placeholder={t('loop.quick.placeholder')} aria-label={t('loop.quick.placeholder')}
                onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addQuick(); }} />
              <Button size="sm" variant="secondary" onClick={addQuick}>{t('loop.quick.add')}</Button>
            </div>
          </>
        ) : (
          <div className="loop-locked">{t('loop.steps.locked')}</div>
        )}
      </div>
      {error !== null && <div className="loop-error" role="alert">{error}</div>}
      <div className="loop-actions">
        {id !== null && <Button variant="danger-text" size="md" onClick={() => void remove()}>{t('common.delete')}</Button>}
        <span className="loop-spacer" />
        <Switch checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })}>{t('loop.enabled')}</Switch>
        <Button variant="secondary" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" size="md" disabled={saving} onClick={() => void save()}>{t('common.save')}</Button>
      </div>
    </div>
  );
}

function StepRow({ step, index, steps, onChange, onMove, onRemove }: {
  step: LoopStep; index: number; steps: LoopStep[];
  onChange: (step: LoopStep) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  return (
    <div className="loop-step">
      <span className="loop-step-no">{index + 1}</span>
      <span className={`loop-kind loop-kind-${step.kind}`}>{t(STEP_KEYS[step.kind])}</span>
      <div className="loop-step-body">
        {step.kind === 'command' && (
          <TextInput mono value={step.text} placeholder={t('loop.step.commandPlaceholder')} aria-label={t('loop.step.command')}
            onChange={(e) => onChange({ kind: 'command', text: e.target.value })} />
        )}
        {step.kind === 'prompt' && (
          <textarea className="ui-input loop-prompt" rows={2} value={step.text} placeholder={t('loop.step.promptPlaceholder')} aria-label={t('loop.step.prompt')}
            onChange={(e) => onChange({ kind: 'prompt', text: e.target.value })} />
        )}
        {step.kind === 'delay' && (
          <span className="loop-delay">
            <NumberInput min={0} step={100} value={Number.isNaN(step.ms) ? '' : step.ms} unit="ms" aria-label={t('loop.step.delay')}
              onChange={(e) => onChange({ kind: 'delay', ms: numberField(e.target.value) })} />
            <span className="loop-delay-sec">{Number.isNaN(step.ms) ? '' : t('loop.step.seconds', { seconds: (step.ms / 1000).toLocaleString(activeLanguage()) })}</span>
            {[1000, 2000, 5000, 10000].map((ms) => (
              <button key={ms} type="button" className="loop-delay-preset" onClick={() => onChange({ kind: 'delay', ms })}>
                {t('loop.step.secondsShort', { seconds: ms / 1000 })}
              </button>
            ))}
          </span>
        )}
        {step.kind === 'end' && <span className="loop-end-text">{t('loop.step.endText')}</span>}
      </div>
      <span className="loop-step-actions">
        <button type="button" aria-label={t('loop.step.up')} disabled={moveStep(steps, index, -1) === steps} onClick={() => onMove(-1)}>↑</button>
        <button type="button" aria-label={t('loop.step.down')} disabled={moveStep(steps, index, 1) === steps} onClick={() => onMove(1)}>↓</button>
        <button type="button" aria-label={t('loop.step.remove')} onClick={onRemove}>✕</button>
      </span>
    </div>
  );
}

function emptyStep(kind: LoopStep['kind']): LoopStep {
  if (kind === 'delay') return { kind, ms: 2000 };
  if (kind === 'end') return { kind };
  return { kind, text: '' };
}

function toggleNumber(list: number[], value: number): number[] {
  return list.includes(value) ? list.filter((n) => n !== value) : [...list, value].sort((a, b) => a - b);
}

function toInput(loop: LoopView): LoopInput {
  const { name, enabled, schedule, shell, cwd, keepTabs, steps } = loop;
  return { name, enabled, schedule, shell, cwd, keepTabs, steps };
}

function intervalLabel(minutes: number): string {
  return minutes % 60 === 0 ? t('loop.every.hours', { count: minutes / 60 }) : t('loop.every.minutes', { count: minutes });
}

function scheduleSummary(schedule: LoopSchedule): string {
  switch (schedule.kind) {
    case 'weekly':
      return `${[1, 2, 3, 4, 5, 6, 0].filter((day) => schedule.days.includes(day)).map((day) => t(DAY_KEYS[day])).join(' ')} · ${schedule.times.join(', ')}`;
    case 'monthly': {
      const dates = schedule.dates.map((date) => t('loop.summary.date', { date }));
      if (schedule.lastDay) dates.push(t('loop.dates.last'));
      return `${t('loop.mode.monthly')} ${dates.join(', ')} · ${schedule.times.join(', ')}`;
    }
    case 'once':
      return `${schedule.date} · ${schedule.times.join(', ')}`;
    case 'interval':
      return t('loop.summary.interval', { every: intervalLabel(schedule.everyMinutes) });
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(activeLanguage(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
