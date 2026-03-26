import { useMemo, useRef, useCallback } from 'react';
import { GridCell } from './GridCell';
import { EmptyCell } from './EmptyCell';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime, GridLayout } from '../../types/workspace';

interface Props {
  tabs: WorkspaceTabRuntime[];
  gridLayout: GridLayout | undefined;
  onAddTab: () => void;
  onRestartTab: (tabId: string) => void;
  renderTerminal: (tab: WorkspaceTabRuntime) => React.ReactNode;
}

export function GridContainer({ tabs, gridLayout, onAddTab, onRestartTab, renderTerminal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const count = tabs.length;

  // Auto grid calculation: cols = ceil(sqrt(n)), rows = ceil(n/cols)
  const { cols, rows } = useMemo(() => {
    if (count === 0) return { cols: 1, rows: 1 };
    let c = Math.ceil(Math.sqrt(count));
    let r = Math.ceil(count / c);
    // Portrait detection: swap if container is taller than wide
    // (simplified — assume landscape for SSR, resize handled by CSS)
    return { cols: c, rows: r };
  }, [count]);

  const totalCells = cols * rows;

  // Order tabs by gridLayout.tabOrder or sortOrder
  const orderedTabs = useMemo(() => {
    if (gridLayout?.tabOrder && gridLayout.tabOrder.length > 0) {
      const map = new Map(tabs.map(t => [t.id, t]));
      return gridLayout.tabOrder.map(id => map.get(id)).filter(Boolean) as WorkspaceTabRuntime[];
    }
    return [...tabs].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [tabs, gridLayout]);

  // Grid template
  const colWidths = gridLayout?.cellSizes?.colWidths;
  const rowHeights = gridLayout?.cellSizes?.rowHeights;
  const gridTemplateColumns = colWidths
    ? colWidths.map(w => `${(w * 100).toFixed(2)}%`).join(' ')
    : `repeat(${cols}, 1fr)`;
  const gridTemplateRows = rowHeights
    ? rowHeights.map(h => `${(h * 100).toFixed(2)}%`).join(' ')
    : `repeat(${rows}, 1fr)`;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'grid',
        gridTemplateColumns,
        gridTemplateRows,
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
