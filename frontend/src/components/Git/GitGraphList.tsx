/**
 * The Git window's commit list: scope buttons, a lane graph per row, ref badges,
 * the uncommitted-changes row, a "not on branch" row for a vanished selection,
 * keyboard navigation (listbox + aria-activedescendant) and pages of 200.
 *
 * @req FR-GIT-005
 * @req FR-GIT-008
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { GitClient, GitLogCommit, GitRef, LogScope, RepoSummary } from './gitApi.ts';
import { layoutGraph, MAX_LANES, type GraphRow } from './gitGraphLayout.ts';
import { graphColumns } from './GitWindow.tsx';
import { activeLanguage, t } from '../../i18n/i18n.ts';
import { formatRelativeTime } from '../../utils/relativeTime.ts';
import './gitViewer.css';

const PAGE = 200;
const ROW_H = 28;
const LANE_W = 14;
const laneX = (k: number) => 10 + Math.min(k, MAX_LANES - 1) * LANE_W;
const laneColor = (c: number) => `var(--lane-${(c % 6) + 1})`;

export interface GitGraphListProps {
  sessionId: string;
  client: Pick<GitClient, 'log' | 'compare'>;
  summary: RepoSummary | null;
  scope: LogScope;
  onScope: (scope: LogScope) => void;
  selected: string;
  onSelect: (key: string) => void;
  width: number;
  /** Bumped by the window to reload the first page. */
  reloadKey: number;
  nameOf: (sessionId: string) => string;
  vanished?: { sha: string; subject: string } | null;
}

interface Row { key: string; commit: GitLogCommit | null; graph: GraphRow | null; kind: 'commit' | 'worktree' | 'vanished' }

function RowGraph({ g, lanes, dashed, h = ROW_H }: { g: GraphRow; lanes: number; dashed: boolean; h?: number }) {
  const w = 10 + lanes * LANE_W;
  const m = h / 2;
  const x = laneX(g.lane);
  const paths: ReactElement[] = [];
  const line = (key: string, d: string, color: number, dash = false) => paths.push(<path key={key} d={d} stroke={laneColor(color)} strokeWidth={2} fill="none" strokeDasharray={dash ? '3 3' : undefined} />);
  g.passThrough.forEach((k) => { if (k < MAX_LANES) line(`p${k}`, `M${laneX(k)} 0 V${h}`, g.colorsBefore[k] ?? 0); });
  g.joinFrom.forEach((k) => line(`j${k}`, `M${laneX(k)} 0 C${laneX(k)} ${m * 0.6} ${x} ${m * 0.4} ${x} ${m}`, g.colorsBefore[k] ?? 0));
  if (!g.isTip) line('up', `M${x} 0 V${m}`, g.color);
  if (g.continuesDown) line('down', `M${x} ${m} V${h}`, g.color, dashed);
  g.mergeTo.forEach((k) => line(`m${k}`, `M${x} ${m} C${x} ${m * 1.6} ${laneX(k)} ${m * 1.3} ${laneX(k)} ${h}`, g.colorsAfter[k] ?? 0));
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="git-row-graph">
      {paths}
      <circle cx={x} cy={m} r={4.5} fill={dashed ? 'var(--bg-chrome)' : laneColor(g.color)} stroke={laneColor(g.color)} strokeWidth={2} strokeDasharray={dashed ? '2 2' : undefined} />
    </svg>
  );
}

function RefBadges({ refs }: { refs: GitRef[] }) {
  if (!refs.length) return null;
  const ordered = [...refs.filter((r) => r.kind === 'head'), ...refs.filter((r) => r.kind !== 'head')];
  const shown = ordered.slice(0, 2);
  const hidden = ordered.slice(2);
  const names = hidden.map((r) => r.name).join(', ');
  return (
    <span className="git-refs">
      {shown.map((r) => <span key={`${r.kind}:${r.name}`} className="git-ref" data-kind={r.kind} title={r.name}>{r.kind === 'head' ? `HEAD → ${r.name}` : r.name}</span>)}
      {hidden.length > 0 && <span className="git-ref" data-more="" title={names} aria-label={t('git.graph.moreRefs', { count: hidden.length, names })}>+{hidden.length}</span>}
    </span>
  );
}

export function GitGraphList({ sessionId, client, summary, scope, onScope, selected, onSelect, width, reloadKey, nameOf, vanished }: GitGraphListProps) {
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [shallow, setShallow] = useState(false);
  const [sessions, setSessions] = useState<Array<{ sessionId: string; head: string }>>([]);
  const [range, setRange] = useState<Set<string> | null>(null);
  const loading = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    loading.current = true;
    client.log(sessionId, { scope, limit: PAGE }, controller.signal).then((page) => {
      setCommits(page.commits);
      setHasMore(page.hasMore);
      setShallow(page.shallow);
      setSessions(page.sessions);
    }, () => {}).finally(() => { loading.current = false; });
    if (scope === 'cmp') {
      client.compare(sessionId, false, controller.signal).then((c) => setRange(new Set(c.commits)), () => setRange(new Set()));
    } else setRange(null);
    return () => controller.abort();
  }, [client, sessionId, scope, reloadKey]);

  const loadMore = useCallback(() => {
    const last = commits[commits.length - 1];
    if (!last || loading.current) return;
    loading.current = true;
    client.log(sessionId, { scope, limit: PAGE, after: last.sha }).then((page) => {
      setCommits((prev) => [...prev, ...page.commits]);
      setHasMore(page.hasMore);
    }, () => {}).finally(() => { loading.current = false; });
  }, [client, commits, scope, sessionId]);

  const withSessions = useMemo(() => commits.map((c) => {
    const marks = sessions.filter((s) => s.head === c.sha).map((s): GitRef => ({ kind: 'local', name: `◉ ${nameOf(s.sessionId)}` }));
    return marks.length ? { ...c, refs: [...c.refs, ...marks] } : c;
  }), [commits, sessions, nameOf]);

  const worktree = scope !== 'cmp' && summary !== null && summary.counts.paths > 0;
  const { rows, laneCount } = useMemo(() => {
    const list = worktree && summary?.head
      ? [{ sha: 'WORKTREE', parents: [summary.head] }, ...withSessions]
      : withSessions;
    const laid = layoutGraph(list);
    const out: Row[] = laid.rows.map((g, i) => {
      const c = worktree ? (i === 0 ? null : withSessions[i - 1]) : withSessions[i];
      return { key: g.sha, commit: c, graph: g, kind: c ? 'commit' : 'worktree' };
    });
    if (vanished && !out.some((r) => r.key === vanished.sha)) out.unshift({ key: vanished.sha, commit: null, graph: null, kind: 'vanished' });
    return { rows: out, laneCount: laid.laneCount };
  }, [withSessions, worktree, summary, vanished]);

  const cols = graphColumns(width);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeId = (key: string) => `git-row-${sessionId}-${key}`;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = Math.max(0, rows.findIndex((r) => r.key === selected));
    const moves: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1, PageDown: 10, PageUp: -10 };
    let next: number | null = null;
    if (e.key in moves) next = i + moves[e.key];
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    if (next === null) return;
    e.preventDefault();
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row) onSelect(row.key);
  };
  useEffect(() => {
    document.getElementById(activeId(selected))?.scrollIntoView?.({ block: 'nearest' });
    // activeId only depends on the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const compareLabel = summary && 'ref' in summary.compare ? t('git.scope.compare', { base: summary.compare.ref }) : t('git.scope.compareNone');
  const compareWhy = summary && 'blocked' in summary.compare ? t(summary.compare.blocked === 'sameAsBase' ? 'git.why.sameAsBase' : 'git.why.noBase') : undefined;
  const now = Date.now();
  const lang = activeLanguage();

  return (
    <div className="git-graph">
      <div className="git-scope" role="group" aria-label={t('git.scope.label')}>
        <button type="button" data-scope="head" aria-pressed={scope === 'head'} onClick={() => onScope('head')}>{t('git.scope.head')}</button>
        <button type="button" data-scope="all" aria-pressed={scope === 'all'} onClick={() => onScope('all')}>{t('git.scope.all')}</button>
        <button type="button" data-scope="cmp" aria-pressed={scope === 'cmp'} disabled={!!compareWhy} title={compareWhy} onClick={() => onScope('cmp')}>{compareLabel}</button>
      </div>
      <div
        ref={listRef}
        className="git-graph-list"
        role="listbox"
        tabIndex={0}
        aria-label={t('git.graph.list')}
        aria-activedescendant={rows.some((r) => r.key === selected) ? activeId(selected) : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((r) => {
          const c = r.commit;
          const sel = r.key === selected;
          const range_ = scope === 'cmp' && r.kind === 'commit' && range ? (range.has(r.key) ? 'in' : 'out') : undefined;
          const subject = r.kind === 'worktree'
            ? t('git.graph.uncommitted', { count: summary?.counts.paths ?? 0 })
            : r.kind === 'vanished' ? t('git.graph.vanishedRow', { subject: vanished?.subject ?? '' }) : c?.subject ?? '';
          const label = c
            ? [c.subject, c.sha.slice(0, 7), c.author, new Date(c.time * 1000).toLocaleString(lang), c.parents.length > 1 ? t('git.graph.merge') : '', ...c.refs.map((x) => x.name)].filter(Boolean).join(', ')
            : subject;
          return (
            <div
              key={r.key}
              id={activeId(r.key)}
              role="option"
              aria-selected={sel}
              aria-label={label}
              data-key={r.key}
              data-kind={r.kind}
              data-range={range_}
              className="git-row"
              onClick={() => onSelect(r.key)}
            >
              {r.graph ? <RowGraph g={r.graph} lanes={laneCount} dashed={r.kind === 'worktree'} /> : <span style={{ width: 10 + laneCount * LANE_W, flexShrink: 0 }} />}
              <span className="git-row-subject">{c && <RefBadges refs={c.refs} />}<span className="git-row-text">{subject}</span></span>
              {cols.sha && <span className="git-row-sha">{c ? c.sha.slice(0, 7) : ''}</span>}
              {cols.author && <span className="git-row-who">{c?.author ?? ''}</span>}
              <span className="git-row-when" title={c ? new Date(c.time * 1000).toLocaleString(lang) : undefined}>{c ? formatRelativeTime(c.time * 1000, now, lang, t('git.time.justNow')) : ''}</span>
            </div>
          );
        })}
        {hasMore && <button type="button" className="git-more" data-load-more="" onClick={loadMore}>{t('git.graph.loadMore', { count: PAGE })}</button>}
        {!hasMore && shallow && <div className="git-more">{t('git.graph.shallow')}</div>}
      </div>
    </div>
  );
}
