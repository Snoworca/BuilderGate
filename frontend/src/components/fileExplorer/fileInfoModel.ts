// FR-FEX-018: the rows of the information modal, as data a test can pin.
import { activeLanguage, t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import type { PathStat } from '../../types/index.ts';
import { formatEntrySize } from './fileListView.ts';

export interface InfoRow {
  labelKey: MessageKey;
  value: string;
}

const KIND_KEYS = {
  file: 'fileExplorer.info.kindFile',
  directory: 'fileExplorer.info.kindDirectory',
  symlink: 'fileExplorer.info.kindSymlink',
  other: 'fileExplorer.info.kindOther',
} satisfies Record<PathStat['kind'], MessageKey>;

/** The relative path as ./a/b with forward slashes, '.' for the session root. */
function dotRelative(relativePath: string): string {
  if (relativePath === '.' || relativePath === '') return './';
  return `./${relativePath.replace(/\\/g, '/')}`;
}

/** Rows in display order; an attribute the server did not report is left out. */
export function buildInfoRows(stat: PathStat, formatTime: (iso: string) => string): InfoRow[] {
  const time = (iso: string) => `${formatTime(iso)} · ${iso}`;
  const bytes = stat.size.toLocaleString(activeLanguage() || 'en');
  const rows: Array<InfoRow | null> = [
    { labelKey: 'fileExplorer.info.name', value: stat.name },
    { labelKey: 'fileExplorer.info.fullPath', value: stat.path },
    { labelKey: 'fileExplorer.info.relativePath', value: dotRelative(stat.relativePath) },
    { labelKey: 'fileExplorer.info.kind', value: t(KIND_KEYS[stat.kind]) },
    {
      labelKey: 'fileExplorer.info.size',
      value: stat.kind === 'directory' ? t('fileExplorer.info.bytes', { bytes }) : `${formatEntrySize({ type: 'file', size: stat.size })} (${t('fileExplorer.info.bytes', { bytes })})`,
    },
    stat.childCount === undefined ? null : { labelKey: 'fileExplorer.info.childCount', value: String(stat.childCount) },
    { labelKey: 'fileExplorer.info.modified', value: time(stat.modified) },
    { labelKey: 'fileExplorer.info.accessed', value: time(stat.accessed) },
    { labelKey: 'fileExplorer.info.changed', value: time(stat.changed) },
    stat.created === undefined ? null : { labelKey: 'fileExplorer.info.created', value: time(stat.created) },
    { labelKey: 'fileExplorer.info.permissions', value: `${stat.permissions} (${stat.mode})` },
    stat.extension ? { labelKey: 'fileExplorer.info.extension', value: stat.extension } : null,
    stat.linkTarget === undefined ? null : { labelKey: 'fileExplorer.info.linkTarget', value: stat.linkTarget },
  ];
  return rows.filter((row): row is InfoRow => row !== null);
}

/** Copy all: one "label<TAB>value" line per row. */
export function formatInfoTable(rows: readonly InfoRow[], label: (key: MessageKey) => string = t): string {
  return rows.map((row) => `${label(row.labelKey)}\t${row.value}`).join('\n');
}
