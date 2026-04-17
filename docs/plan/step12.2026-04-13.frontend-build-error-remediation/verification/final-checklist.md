# Final Checklist

## Build

- `cd frontend && npm run build` passes without TypeScript errors.
- No error output references:
  - `Grid/MosaicContainer.tsx`
  - `Grid/MosaicTile.tsx`
  - `Header/Header.tsx`
  - `MetadataBar/MetadataRow.tsx`
  - `Workspace/WorkspaceItem.tsx`
  - `Workspace/WorkspaceTabBar.tsx`
  - `utils/contextMenuBuilder.ts`

## Context Menu

- Workspace context menu opens correctly.
- Workspace context menu separator renders correctly.
- Tab context menu opens correctly.
- Terminal context menu opens correctly.
- Terminal submenu for multi-shell add renders correctly.
- Copy and paste actions still trigger without console errors.

## Grid

- Grid equal mode renders correctly.
- Grid focus mode resizes the selected pane correctly.
- Grid auto mode still reacts to session status changes.
- Closing or restarting a tile still works.

## Header And Metadata

- Header cwd shows the active terminal path and truncates cleanly.
- Header actions still align correctly on desktop.
- Mobile header still shows the hamburger menu correctly.
- Metadata row still renders name, cwd, and elapsed time in tab mode.
- Metadata row still renders name, cwd, and elapsed time in grid mode.

## Regression Guard

- Terminal/workspace switching behavior fixed earlier remains intact.
- No new TypeScript errors appear in shared menu consumers after the `ContextMenuItem` union change.
