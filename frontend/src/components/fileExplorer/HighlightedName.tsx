// FR-FEX-014 AC-2: a name with the type-to-filter match drawn on a distinct background.
import { matchRange } from './fileExplorerTypeFilter.ts';

export function HighlightedName({ name, text }: { name: string; text: string }) {
  const range = matchRange(name, text);
  if (range === null) return <>{name}</>;
  const [start, end] = range;
  return (
    <>
      {name.slice(0, start)}
      <mark className="fx-hit">{name.slice(start, end)}</mark>
      {name.slice(end)}
    </>
  );
}
