import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import ts from 'typescript';
import { buildWorkspaceMoveTargets } from '../../src/components/Workspace/workspaceMoveTargets.ts';
import { TAB_COLORS } from '../../src/types/workspace.ts';
import { getRecoveryIconLabel } from '../../src/types/recoveryOption.ts';

// Execute existing component render logic with real React elements and inert
// unrelated hooks. This verifies capacity-dependent props, not browser layout.
function sourceFile(path: string): ts.SourceFile {
  const url = new URL(path, import.meta.url);
  return ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function component(path: string, name: string, dependencies: Record<string, unknown>, helper?: string) {
  const ast = sourceFile(path);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const selected = functions.filter(node => node.name?.text === name || node.name?.text === helper);
  assert.equal(selected.filter(node => node.name?.text === name).length, 1);
  if (helper) assert.equal(selected.filter(node => node.name?.text === helper).length, 1);
  const code = selected.map(node => node.getText(ast).replace(/^export\s+/u, '')).join('\n');
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function('React', ...Object.keys(dependencies), `${output}\nreturn ${name};`)(React, ...Object.values(dependencies)) as (props: Record<string, unknown>) => React.ReactNode;
}
function appLimit(tag: string, prop: string, limits: Record<string, number>): number {
  const ast = sourceFile('../../src/App.tsx');
  const expressions: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === tag) {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === prop) {
          assert.ok(attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
          expressions.push(attribute.initializer.expression);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(expressions.length, 1, `actual ${tag}.${prop} expression must exist exactly once`);
  return new Function('wm', `return (${expressions[0].getText(ast)});`)({ limits });
}
function elements(tree: React.ReactNode, type: string): Array<React.ReactElement<{ disabled?: boolean; onClick?: () => void; children?: React.ReactNode }>> {
  const found: Array<React.ReactElement<{ disabled?: boolean; onClick?: () => void; children?: React.ReactNode }>> = [];
  React.Children.forEach(tree, child => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return;
    if (child.type === type) found.push(child);
    found.push(...elements(child.props.children, type));
  });
  return found;
}
const buttons = (tree: React.ReactNode) => elements(tree, 'button');
const noop = () => {};
const sidebar = component('../../src/components/Workspace/WorkspaceSidebar.tsx', 'WorkspaceSidebar', {
  useState: (initial: unknown) => [initial, noop], useCallback: (callback: unknown) => callback,
  useDragReorder: () => ({ getTabHandlers: () => ({}), dropTargetIndex: null, dragIndex: null, ghostStyle: null, tabRefs: { current: [] } }),
  WorkspaceItem: 'workspace-item', ContextMenu: 'context-menu',
});
const moveDialog = component('../../src/components/Workspace/WorkspaceMoveDialog.tsx', 'WorkspaceMoveDialog', {
  WindowDialog: 'window-dialog', buildWorkspaceMoveTargets,
}, 'reasonLabel');
const workspace = (id: string, sortOrder = 0) => ({ id, name: id, sortOrder, viewMode: 'tab', activeTabId: null, createdAt: 1 });

for (const limit of [3, 20, 3.5, 10]) {
  test(`FR-BGSTAB-026 App to actual Sidebar applies workspace capacity ${limit}`, () => {
    const maxWorkspaces = appLimit('WorkspaceSidebar', 'maxWorkspaces', { maxWorkspaces: limit, maxTabsPerWorkspace: 8 });
    assert.equal(maxWorkspaces, limit);
    for (const count of [Math.ceil(limit) - 1, Math.ceil(limit), Math.ceil(limit) + 1]) {
      const onCreate = noop;
      const tree = sidebar({
        workspaces: Array.from({ length: count }, (_, i) => workspace(`w${i}`, i)), tabs: [], activeWorkspaceId: null,
        maxWorkspaces, onCreate, onSelect: noop, onRename: noop, onDelete: noop, onAddTab: noop, onReorder: noop,
      });
      const create = buttons(tree).filter(button => button.props.onClick === onCreate);
      assert.equal(create.length, 1, 'actual creation control must be rendered');
      assert.equal(create[0].props.disabled, count >= limit);
    }
  });
}
for (const limit of [2, 12, 4.5, 8]) {
  test(`FR-BGSTAB-026 App to actual MoveDialog applies tab capacity ${limit}`, () => {
    const maxTabsPerWorkspace = appLimit('WorkspaceMoveDialog', 'maxTabsPerWorkspace', { maxWorkspaces: 10, maxTabsPerWorkspace: limit });
    assert.equal(maxTabsPerWorkspace, limit);
    for (const count of [Math.ceil(limit) - 1, Math.ceil(limit), Math.ceil(limit) + 1]) {
      const moves: string[] = [];
      const tree = moveDialog({
        open: true, workspaces: [workspace('source'), workspace('target', 1)],
        tabs: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, workspaceId: 'target', sortOrder: i, status: 'idle' })),
        sourceWorkspaceId: 'source', maxTabsPerWorkspace, moving: false, error: null, onMove: (id: string) => moves.push(id), onClose: noop,
      });
      const rendered = buttons(tree);
      assert.equal(rendered.length, 3, 'two workspace choices and cancellation must be rendered');
      assert.equal(rendered[0].props.disabled, true, 'current workspace remains ineligible');
      assert.equal(rendered[1].props.disabled, count >= limit);
      if (!rendered[1].props.disabled) rendered[1].props.onClick!();
      assert.deepEqual(moves, count >= limit ? [] : ['target']);
    }
  });
}

const tabBar = component('../../src/components/Workspace/WorkspaceTabBar.tsx', 'WorkspaceTabBar', {
  useState: (initial: unknown) => [initial, noop], useRef: (initial: unknown) => ({ current: initial }),
  useEffect: noop, useCallback: (callback: unknown) => callback,
  useContextMenu: () => ({ isOpen: false, targetId: null, open: noop, close: noop }),
  useLongPress: () => ({ wasLongPress: () => false, onPointerDown: noop, onPointerUp: noop, onPointerMove: noop }),
  useDragReorder: () => ({ getTabHandlers: () => ({}), dropTargetIndex: null, dragIndex: null, ghostStyle: null, tabRefs: { current: [] } }),
  TAB_COLORS, getRecoveryIconLabel, ContextMenu: 'context-menu',
}, 'getSafeRecoveryIconLabel');
const workspaceItem = component('../../src/components/Workspace/WorkspaceItem.tsx', 'WorkspaceItem', {
  useState: (initial: unknown) => [initial, noop], useRef: (initial: unknown) => ({ current: initial }), useEffect: noop,
  useContextMenu: () => ({ isOpen: true, targetId: 'target', position: { x: 10, y: 20 }, open: noop, close: noop }),
  ContextMenu: 'context-menu',
});
const capacityTabs = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `tab-${index}`, sessionId: `session-${index}`, workspaceId: 'target', name: `Terminal ${index}`,
  sortOrder: index, colorIndex: 0, status: 'idle',
}));

for (const limit of [8, 2, 12, 4.5]) {
  test(`FR-BGSTAB-026 CAP-07 App to actual TabBar applies creation capacity ${limit}`, () => {
    const limits = { maxWorkspaces: 10, maxTabsPerWorkspace: limit };
    const maxTabs = appLimit('WorkspaceTabBar', 'maxTabs', limits);
    const maxSessions = appLimit('WorkspaceTabBar', 'maxSessions', limits);
    assert.equal(maxTabs, limit);
    assert.equal(maxSessions, 32);
    for (const count of [Math.ceil(limit) - 1, Math.ceil(limit), Math.ceil(limit) + 1]) {
      let created = 0;
      const tree = tabBar({
        tabs: capacityTabs(count), activeTabId: null, totalSessionCount: count, maxTabs, maxSessions,
        onAddTab: () => { created += 1; }, onSelectTab: noop, onCloseTab: noop, onRenameTab: noop, onReorderTabs: noop,
      });
      const add = buttons(tree).filter(button => String(button.props.children).trim() === '+');
      assert.equal(add.length, 1, 'render the actual tab creation button');
      assert.equal(add[0].props.disabled, count >= limit);
      add[0].props.onClick!();
      assert.equal(created, count >= limit ? 0 : 1, 'the production click handler also preserves the creation guard');
    }
  });

  test(`FR-BGSTAB-026 CAP-07 App through Sidebar to actual Item menu applies creation capacity ${limit}`, () => {
    const limits = { maxWorkspaces: 10, maxTabsPerWorkspace: limit };
    const maxTabsPerWorkspace = appLimit('WorkspaceSidebar', 'maxTabsPerWorkspace', limits);
    assert.equal(maxTabsPerWorkspace, limit);
    for (const count of [Math.ceil(limit) - 1, Math.ceil(limit), Math.ceil(limit) + 1]) {
      const created: string[] = [];
      const tree = sidebar({
        workspaces: [workspace('target')], tabs: capacityTabs(count), activeWorkspaceId: null,
        maxWorkspaces: appLimit('WorkspaceSidebar', 'maxWorkspaces', limits), maxTabsPerWorkspace,
        onCreate: noop, onSelect: noop, onRename: noop, onDelete: noop, onReorder: noop,
        onAddTab: (id: string) => created.push(id),
      });
      const items = elements(tree, 'workspace-item');
      assert.equal(items.length, 1, 'use the actual Sidebar-produced WorkspaceItem props');
      const itemTree = workspaceItem(items[0].props);
      const menus = elements(itemTree, 'context-menu');
      assert.equal(menus.length, 1);
      const menuItems = (menus[0].props as { items?: Array<{ label?: string; disabled?: boolean; onClick?: () => void }> }).items;
      assert.ok(menuItems);
      const add = menuItems.filter(item => item.label === 'Add Terminal');
      assert.equal(add.length, 1, 'the actual WorkspaceItem must supply its existing Add Terminal menu entry');
      assert.equal(add[0].disabled, count >= limit);
      if (!add[0].disabled) add[0].onClick!();
      assert.deepEqual(created, count >= limit ? [] : ['target']);
    }
  });
}

test('FR-BGSTAB-026 CAP-07 TabBar keeps the independent 32-session creation guard', () => {
  const limits = { maxWorkspaces: 20, maxTabsPerWorkspace: 12 };
  const maxSessions = appLimit('WorkspaceTabBar', 'maxSessions', limits);
  assert.equal(maxSessions, 32);
  for (const totalSessionCount of [31, 32, 33]) {
    let created = 0;
    const tree = tabBar({
      tabs: capacityTabs(1), activeTabId: null, totalSessionCount,
      maxTabs: appLimit('WorkspaceTabBar', 'maxTabs', limits), maxSessions,
      onAddTab: () => { created += 1; }, onSelectTab: noop, onCloseTab: noop, onRenameTab: noop, onReorderTabs: noop,
    });
    const add = buttons(tree).filter(button => String(button.props.children).trim() === '+');
    assert.equal(add.length, 1);
    assert.equal(add[0].props.disabled, totalSessionCount >= 32);
    add[0].props.onClick!();
    assert.equal(created, totalSessionCount >= 32 ? 0 : 1);
  }
});
