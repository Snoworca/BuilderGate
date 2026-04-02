import { useMemo, useRef } from 'react';
import { GridCell } from './GridCell';
import { EmptyCell } from './EmptyCell';
import { TAB_COLORS } from '../../types/workspace';
import { extractLeafIds } from '../../utils/mosaic';
import type { WorkspaceTabRuntime, GridLayout } from '../../types/workspace';

interface Props {
  tabs: WorkspaceTabRuntime[];
  gridLayout: GridLayout | undefined;
  onAddTab: () => void;
  onRestartTab: (tabId: string) => void;
  renderTerminal: (tab: WorkspaceTabRuntime) => React.ReactNode;
}

// Legacy GridContainer — will be replaced by MosaicContainer in Phase 2
export function GridContainer({ tabs, gridLayout, onAddTab, onRestartTab, renderTerminal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const count = tabs.length;

  const { cols, rows } = useMemo(() => {
    if (count === 0) return { cols: 1, rows: 1 };
    const c = Math.ceil(Math.sqrt(count));
    const r = Math.ceil(count / c);
    return { cols: c, rows: r };
  }, [count]);

  const totalCells = cols * rows;

  // Order tabs by mosaicTree leaf order or sortOrder
  const orderedTabs = useMemo(() => {
    if (gridLayout?.mosaicTree) {
      const leafIds = extractLeafIds(gridLayout.mosaicTree);
      const map = new Map(tabs.map(t => [t.id, t]));
      return leafIds.map(id => map.get(id)).filter(Boolean) as WorkspaceTabRuntime[];
    }
    return [...tabs].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [tabs, gridLayout]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        width: '100%',
        height: '100%',
        gap: 0,
        backgroundColor: 'var(--terminal-bg, #1e1e1e)',
      }}
    >
      {Array.from({ length: totalCells }, (_, index) => {
        const tab = orderedTabs[index];
        if (tab) {
          return (
            <GridCell
              key={tab.id}
              tab={tab}
              color={TAB_COLORS[tab.colorIndex] || TAB_COLORS[0]}
              onRestart={() => onRestartTab(tab.id)}
            >
              {renderTerminal(tab)}
            </GridCell>
          );
        }
        return <EmptyCell key={`empty-${index}`} onAdd={onAddTab} />;
      })}
    </div>
  );
}
