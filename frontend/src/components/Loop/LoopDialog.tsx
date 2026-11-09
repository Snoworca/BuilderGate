// FR-LOOP-006, FR-LOOP-008: Tools › Loop — the loop list and the loop editor
// (docs/design/loop-scheduler.html, docs/design/loop-existing-session.html).
import { useCallback, useEffect, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Button, Checkbox, Chip, Field, NumberInput, Select, Switch, TextInput } from '../ui';
import { activeLanguage, t, tn, type MessageKey } from '../../i18n/i18n.ts';
import { loopApi, sessionApi } from '../../services/api.ts';
import type { ShellInfo } from '../../types';
import { appendSteps, canAddStep, localDate, moveStep, newLoopDraft, numberField, parseLoopLine } from './loopModel.ts';
import { DAY_KEYS, MODE_KEYS, RESULT_KEYS, RUN_REASON_KEYS, STEP_KEYS } from './loopMessages.ts';
import { canAddStepKind, canOpenRunTab, hasChoosableSession, lastResultReason, loopsOnSameTab, missingSince, saveBlocker, sessionGroups, sessionStatus, targetSummary, toLoopInput, type SaveBlocker } from './loopTarget.ts';
import type { LoopInput, LoopRun, LoopSchedule, LoopSessionOption, LoopStep, LoopTarget, LoopTargetKind, LoopView } from './loopTypes.ts';
import './LoopDialog.css';

interface LoopDialogProps {
  onClose: () => void;
  /** The active tab's folder, offered to a new loop. */
  defaultCwd?: string | null;
  /** AC-1: the Tools menu shows how many loops are on. */
  onEnabledCountChange?: (count: number) => void;
  /** FR-LOOP-008 AC-9: 「탭 열기」 in the run history moves the screen to that tab. */
  onOpenTab?: (tabId: string) => void;
}

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function LoopDialog({ onClose, defaultCwd, onEnabledCountChange, onOpenTab }: LoopDialogProps) {
  const [loops, setLoops] = useState<LoopView[] | null>(null);
  const [sessions, setSessions] = useState<LoopSessionOption[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: LoopInput } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, LoopRun[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, tabs] = await Promise.all([loopApi.list(), loopApi.sessions()]);
      setLoops(list);
      setSessions(tabs);
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
      await loopApi.save(loop.id, { ...toLoopInput(loop), enabled: !loop.enabled });
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
          loops={loops ?? []}
          sessions={sessions}
          lastRun={loops?.find((loop) => loop.id === editing.id)?.lastRun ?? null}
          onCancel={() => setEditing(null)}
          onDone={async () => { setEditing(null); await refresh(); }}
        />
      ) : (
        <div className="loop-dialog" data-testid="loop-dialog">
          <div className="loop-toolbar">
            <Button variant="primary" size="md" icon="plus" onClick={() => {
              const draft = newLoopDraft(new Date());
              setEditing({ id: null, draft: { ...draft, target: { kind: 'new', shell: 'auto', cwd: defaultCwd ?? '', keepTabs: 1 } } });
            }}>
              {t('loop.new')}
            </Button>
            <span className="loop-help">{t('loop.help')}</span>
          </div>
          {error !== null && <div className="loop-error" role="alert">{error}</div>}
          <div className="loop-list" role="list">
            {loops !== null && loops.length === 0 && <div className="loop-empty">{t('loop.empty')}</div>}
            {loops?.map((loop) => {
              const target = targetSummary(loop);
              return (
              <div key={loop.id} role="listitem" className={`loop-row${loop.enabled ? '' : ' loop-row-off'}${target.missing ? ' loop-row-missing' : ''}`}>
                <div className="loop-row-main">
                  <Switch checked={loop.enabled} aria-label={t('loop.enabled')} onChange={() => void toggle(loop)} />
                  <button type="button" className="loop-row-text" aria-expanded={expanded === loop.id} onClick={() => expand(loop.id)}>
                    <span className="loop-name">
                      {loop.name}
                      {target.missing && <Chip tone="warn" className="loop-missing-badge">{t('loop.badge.missing')}</Chip>}
                    </span>
                    <span className="loop-sub">
                      {scheduleSummary(loop.schedule)} · {target.kind === 'session'
                        ? <span className={`loop-target-chip${target.missing ? ' loop-target-gone' : ''}`}>→ {target.text}</span>
                        : <span className="loop-mono">{target.text}</span>} · {tn('loop.stepCount', loop.steps.length)}
                    </span>
                  </button>
                  <span className="loop-next">
                    <span className="loop-col-label">{t('loop.col.next')}</span>
                    {loop.enabled ? (loop.nextRunAt ? formatTime(loop.nextRunAt) : t('loop.next.none')) : t('loop.next.off')}
                  </span>
                  <span className={`loop-result loop-result-${loop.lastRun?.result ?? 'never'}`}>
                    <span className="loop-col-label">{t('loop.col.last')}</span>
                    {loop.lastRun ? lastResultText(loop.lastRun) : t('loop.result.never')}
                  </span>
                  <span className="loop-row-actions">
                    <Button size="sm" variant="secondary" disabled={busy === loop.id} onClick={() => void runNow(loop)}>{t('loop.runNow')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ id: loop.id, draft: toLoopInput(loop) })}>{t('loop.edit')}</Button>
                  </span>
                </div>
                {expanded === loop.id && (
                  <RunHistory runs={runs[loop.id]} onOpenTab={onOpenTab} />
                )}
              </div>
              );
            })}
          </div>
          <div className="loop-actions">
            <Button variant="secondary" size="md" onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      )}
    </WindowDialog>
  );
}

function RunHistory({ runs, onOpenTab }: { runs: LoopRun[] | undefined; onOpenTab?: (tabId: string) => void }) {
  if (runs === undefined) return null;
  if (runs.length === 0) return <div className="loop-history loop-empty">{t('loop.history.empty')}</div>;
  return (
    <table className="loop-history">
      <thead>
        <tr>
          <th>{t('loop.col.time')}</th>
          <th>{t('loop.col.result')}</th>
          <th>{t('loop.col.target')}</th>
          <th>{t('loop.col.steps')}</th>
          <th aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>{formatTime(run.startedAt)}</td>
            <td className={`loop-result-${run.result}`}>{t(RESULT_KEYS[run.result])}</td>
            <td>{run.workspaceName ? `${run.workspaceName} : ${run.tabName ?? ''}` : ''}</td>
            <td>
              {tn('loop.history.steps', run.totalSteps, { sent: run.stepsSent })}
              {run.reason && <span className="loop-history-reason"> · {t(RUN_REASON_KEYS[run.reason], { detail: run.detail ?? '' })}</span>}
            </td>
            <td>
              {canOpenRunTab(run) && onOpenTab && (
                <button type="button" className="loop-link" onClick={() => onOpenTab(run.tabId!)}>{t('loop.history.openTab')}</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const INTERVAL_PRESETS = [10, 20, 30, 60, 120, 360] as const;

const BLOCKER_KEYS = {
  emptyText: 'loop.error.emptyText',
  endNotAllowed: 'loop.error.endNotAllowed',
  noSession: 'loop.session.placeholder',
  noSessions: 'loop.session.none',
} as const satisfies Record<SaveBlocker, MessageKey>;

type NewTarget = Extract<LoopTarget, { kind: 'new' }>;
type SessionTarget = Extract<LoopTarget, { kind: 'session' }>;

function LoopEditor({ id, initial, loops, sessions, lastRun, onCancel, onDone }: {
  id: string | null; initial: LoopInput; loops: LoopView[]; sessions: LoopSessionOption[] | null; lastRun: LoopRun | null;
  onCancel: () => void; onDone: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<LoopInput>(initial);
  // FR-LOOP-008 AC-8: both tabs keep their values until saving; only the visible one is saved.
  const [targetKind, setTargetKind] = useState<LoopTargetKind>(initial.target.kind);
  const [newTarget, setNewTarget] = useState<NewTarget>(
    initial.target.kind === 'new' ? initial.target : { kind: 'new', shell: 'auto', cwd: '', keepTabs: 1 },
  );
  const [sessionTarget, setSessionTarget] = useState<SessionTarget>(
    initial.target.kind === 'session' ? initial.target : { kind: 'session', tabId: '', label: { workspaceName: '', tabName: '' }, skipWhenBusy: true },
  );
  const target: LoopTarget = targetKind === 'new' ? newTarget : sessionTarget;
  const current: LoopInput = { ...draft, target };
  const liveSessions = sessions ?? [];
  const blocker = sessions === null && targetKind === 'session' ? null : saveBlocker(current, liveSessions);
  const savedTabGone = initial.target.kind === 'session' && sessions !== null && !liveSessions.some((tab) => tab.tabId === (initial.target as SessionTarget).tabId);
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
      await loopApi.save(id, current);
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
    const parsed = parseLoopLine(quick).filter((step) => canAddStepKind(step.kind, targetKind));
    if (parsed.length === 0) return;
    setSteps(appendSteps(draft.steps, parsed));
    setQuick('');
  };
  const patchNew = (changes: Partial<NewTarget>) => setNewTarget((value) => ({ ...value, ...changes }));
  const chooseSession = (tabId: string) => {
    const tab = liveSessions.find((entry) => entry.tabId === tabId);
    setSessionTarget((value) => ({ ...value, tabId, label: tab ? { workspaceName: tab.workspaceName, tabName: tab.tabName } : value.label }));
  };

  return (
    <div className="loop-dialog loop-editor" data-testid="loop-editor">
      <div className="loop-editor-body">
        {savedTabGone && targetKind === 'session' && sessionTarget.tabId === (initial.target as SessionTarget).tabId && (
          <div className="loop-warn-banner" role="status">
            <span>{missingBannerText(initial.enabled, missingSince(lastRun))}</span>
            {!hasChoosableSession(liveSessions) && (
              <Button size="sm" variant="secondary" onClick={() => setTargetKind('new')}>{t('loop.session.switchToNew')}</Button>
            )}
          </div>
        )}
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
        <Field label={t('loop.field.target')}>
          <div className="loop-target-tabs" role="tablist" aria-label={t('loop.field.target')}>
            {(['new', 'session'] as const).map((kind) => (
              <button key={kind} type="button" role="tab" aria-selected={targetKind === kind} onClick={() => setTargetKind(kind)}>
                {kind === 'new' ? `＋ ${t('loop.target.new')}` : `→ ${t('loop.target.session')}`}
              </button>
            ))}
          </div>
        </Field>
        {targetKind === 'new' ? (
          <>
            <Field label={t('loop.field.shell')} htmlFor="loop-shell">
              <Select id="loop-shell" value={newTarget.shell} onChange={(e) => patchNew({ shell: e.target.value as NewTarget['shell'] })}>
                <option value="auto">{t('loop.shell.auto')}</option>
                {shells.filter((shell) => shell.id !== 'auto').map((shell) => <option key={shell.id} value={shell.id}>{shell.label}</option>)}
                {newTarget.shell !== 'auto' && !shells.some((shell) => shell.id === newTarget.shell) && <option value={newTarget.shell}>{newTarget.shell}</option>}
              </Select>
            </Field>
            <Field label={t('loop.field.cwd')} htmlFor="loop-cwd" help={t('loop.cwd.help')}>
              <TextInput id="loop-cwd" mono value={newTarget.cwd} onChange={(e) => patchNew({ cwd: e.target.value })} />
            </Field>
            <Field label={t('loop.field.keepTabs')} htmlFor="loop-keep" help={t('loop.keepTabs.help')}>
              <NumberInput id="loop-keep" min={1} max={16} value={Number.isNaN(newTarget.keepTabs) ? '' : newTarget.keepTabs} onChange={(e) => patchNew({ keepTabs: numberField(e.target.value) })} />
            </Field>
          </>
        ) : (
          <SessionFields
            target={sessionTarget}
            sessions={sessions}
            savedTabGone={savedTabGone}
            otherLoops={sessionTarget.tabId ? loopsOnSameTab(loops, sessionTarget.tabId, id) : 0}
            onChoose={chooseSession}
            onSkipWhenBusy={(skipWhenBusy) => setSessionTarget((value) => ({ ...value, skipWhenBusy }))}
            onSwitchToNew={() => setTargetKind('new')}
          />
        )}

        <div className="loop-section">{t('loop.section.what')}</div>
        {blocker === 'endNotAllowed' && <div className="loop-error" role="alert">⚠ {t('loop.error.endNotAllowed')}</div>}
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
              {(Object.keys(STEP_KEYS) as Array<LoopStep['kind']>).filter((kind) => canAddStepKind(kind, targetKind)).map((kind) => (
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
      {blocker !== null && blocker !== 'endNotAllowed' && <div className="loop-error" role="alert">{t(BLOCKER_KEYS[blocker])}</div>}
      <div className="loop-actions">
        {id !== null && <Button variant="danger-text" size="md" onClick={() => void remove()}>{t('common.delete')}</Button>}
        <span className="loop-spacer" />
        <Switch checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })}>{t(draft.enabled ? 'loop.enabled' : 'loop.disabled')}</Switch>
        <Button variant="secondary" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" size="md" disabled={saving || blocker !== null} onClick={() => void save()}>{t('common.save')}</Button>
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

/** FR-LOOP-008 AC-8: the 「기존 세션」 tab of 「어디서」. */
function SessionFields({ target, sessions, savedTabGone, otherLoops, onChoose, onSkipWhenBusy, onSwitchToNew }: {
  target: SessionTarget; sessions: LoopSessionOption[] | null; savedTabGone: boolean; otherLoops: number;
  onChoose: (tabId: string) => void; onSkipWhenBusy: (skip: boolean) => void; onSwitchToNew: () => void;
}) {
  if (sessions === null) return null;
  const chosen = sessions.find((tab) => tab.tabId === target.tabId) ?? null;
  const showGone = savedTabGone && target.tabId !== '' && chosen === null;
  if (!hasChoosableSession(sessions) && !showGone) {
    return (
      <Field label={t('loop.field.session')}>
        <div className="loop-session-empty">
          <span>{t('loop.session.none')}</span>
          <Button size="sm" variant="secondary" onClick={onSwitchToNew}>{t('loop.session.switchToNew')}</Button>
        </div>
      </Field>
    );
  }
  const status = chosen ? sessionStatus(chosen) : null;
  return (
    <>
      <Field label={t('loop.field.session')} htmlFor="loop-session">
        <Select id="loop-session" value={target.tabId} onChange={(e) => onChoose(e.target.value)}>
          <option value="" disabled>{t('loop.session.placeholder')}</option>
          {showGone && (
            <option value={target.tabId} disabled>
              {t('loop.session.missingOption', { target: `${target.label.workspaceName} : ${target.label.tabName}` })}
            </option>
          )}
          {sessionGroups(sessions).map((group) => (
            <optgroup key={group.workspaceId} label={group.name}>
              {group.options.map((entry) => {
                const words = sessionStatus(entry.session);
                return (
                  <option key={entry.tabId} value={entry.tabId} disabled={entry.disabled}>
                    {`${entry.name} — ${t(words.key, words.params)}`}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </Select>
        {!hasChoosableSession(sessions) && <div className="loop-help loop-session-none">{t('loop.session.none')}</div>}
        {chosen && status && (
          <div className="loop-session-card">
            <span className="loop-session-card-name">→ {chosen.workspaceName} <strong>{chosen.tabName}</strong></span>
            <Chip tone={status.tone}>{t(status.key, status.params)}</Chip>
            <span className="loop-session-card-meta loop-mono">{chosen.cwd} · {chosen.shell}</span>
          </div>
        )}
        <div className="loop-help">{t('loop.session.hint')} {t('loop.session.typingHint')}</div>
        {otherLoops > 0 && <div className="loop-help">{tn('loop.session.otherLoops', otherLoops)}</div>}
      </Field>
      <Field label={t('loop.field.whenBusy')} help={t('loop.session.skipBusyHelp')}>
        <Checkbox checked={target.skipWhenBusy} onChange={(e) => onSkipWhenBusy(e.target.checked)}>{t('loop.session.skipBusy')}</Checkbox>
      </Field>
    </>
  );
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

/** FR-LOOP-008 AC-9: 「건너뜀 · 에이전트 작업 중」 when skipped for a reason, else the result and its time. */
function lastResultText(run: LoopRun): string {
  const reason = lastResultReason(run);
  return reason ? `${t(RESULT_KEYS[run.result])} · ${t(reason)}` : `${t(RESULT_KEYS[run.result])} · ${formatTime(run.startedAt)}`;
}

/** FR-LOOP-008 AC-8: a loop still on has not been turned off yet; one turned off says when. */
function missingBannerText(enabled: boolean, since: string | null): string {
  if (enabled) return t('loop.error.sessionMissing');
  return since ? t('loop.session.missingBannerAt', { time: formatShortTime(since) }) : t('loop.session.missingBanner');
}

/** 「11/07 17:00」 in the active UI language. */
function formatShortTime(iso: string): string {
  return new Date(iso).toLocaleString(activeLanguage(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(activeLanguage(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
