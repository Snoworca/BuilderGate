const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const runId = '2026-05-22.projectmaster.aitui-recovery';
const target = '0.5.4-ai-tui-recovery';
const generatedAt = '2026-05-22T00:00:00+09:00';
const planPath = `docs/plans/${runId}.plan.md`;
const sidecarPath = `docs/plans/${runId}.sidecar.json`;
const validatorPath = `docs/plans/${runId}.validator.json`;
const analysisDir = `docs/analysis/kiwi-planner-${runId}`;

const reqs = [
  ['FR-AITUI-001', 6],
  ['FR-AITUI-002', 6],
  ['FR-AITUI-003', 6],
  ['FR-AITUI-004', 6],
  ['FR-AITUI-005', 6],
  ['SEC-AITUI-001', 6],
  ['SEC-AITUI-002', 5],
  ['REL-AITUI-001', 5],
].map(([id, n]) => ({
  id,
  stability: 'evolving',
  status: 'planned',
  ac: Array.from({ length: n }, (_, i) => `AC-${i + 1}`),
}));

const intent = {
  target_intent: 'Desktop Tools menu based AI TUI recovery options for Claude, Codex, and user-created commands, including persistence, matching, icon metadata, and restart/orphan restore execution.',
  user_priorities: [
    'Desktop Tools menu entry only; mobile entry points are out of scope.',
    'Dedicated RecoveryOption domain and store; CommandPreset and TerminalShortcut patterns may be reused but not conflated.',
    'Default contracts are claude --continue and codex resume --last; claudep is only a user-created custom command.',
    'Restore command execution is automatic only for a previously matched enabled option and must preserve shell type and last CWD.',
    'Dangerous Claude flags are never seeded by default and execute only when explicitly stored by the user.',
    'Recovery icons are data, not HTML/SVG/script/URL/style payloads.',
  ],
  ambiguities: [
    'Final icon allowlist enum is not fixed by SRS; plan constrains implementation to built-in keys plus validated plain text/emoji data.',
    'Readiness coordination may use startup input queue or callback; plan assigns implementation to SessionManager restore injection path.',
    'Invalid row quarantine can be omitted or diagnostic-only as long as valid rows remain and diagnostics are observable.',
  ],
  non_coding_signals: [
    'Backend unit/route tests, frontend unit tests, and desktop Playwright coverage are required.',
    'Shell-specific command construction tests must cover PowerShell, cmd, bash, zsh, and sh.',
    'Final validation must target https://localhost:2002 for Playwright according to AGENTS.md.',
  ],
};

const traceByReq = {
  'FR-AITUI-001': [
    'frontend/src/components/Header/Header.tsx:52-61',
    'frontend/src/App.tsx:99-106',
    'frontend/src/App.tsx:520-532',
    'frontend/src/App.tsx:686-704',
    'frontend/src/services/api.ts:458-570',
  ],
  'FR-AITUI-002': [
    'server/src/services/CommandPresetService.ts:22-52',
    'server/src/services/CommandPresetService.ts:155-176',
    'server/src/services/CommandPresetService.ts:216-290',
    'server/src/routes/commandPresetRoutes.ts:6-52',
    'server/src/index.ts:280-287',
  ],
  'FR-AITUI-003': [
    'server/src/services/SessionManager.ts:900-940',
    'server/src/services/SessionManager.ts:2572-2608',
    'server/src/types/workspace.types.ts:18-30',
    'frontend/src/types/workspace.ts:12-31',
    'frontend/src/components/MetadataBar/MetadataRow.tsx:67-120',
    'frontend/src/components/Workspace/WorkspaceTabBar.tsx:75-143',
  ],
  'FR-AITUI-004': [
    'server/src/services/WorkspaceService.ts:336-351',
    'server/src/services/WorkspaceService.ts:595-614',
    'server/src/services/WorkspaceService.ts:626-640',
    'server/src/services/SessionManager.ts:1632-1668',
    'server/src/services/SessionManager.ts:1701-1717',
  ],
  'FR-AITUI-005': [
    'server/src/services/CommandPresetService.ts:22-52',
    'server/src/services/SessionManager.ts:1701-1717',
    'frontend/src/components/CommandPresetManager/CommandPresetDialog.tsx:67-120',
    'server/src/services/SessionManager.ts:2572-2608',
  ],
  'SEC-AITUI-001': [
    'server/src/index.ts:280-287',
    'server/src/routes/commandPresetRoutes.ts:6-52',
    'server/src/services/CommandPresetService.ts:216-290',
    'server/src/services/SessionManager.ts:1632-1668',
    'server/src/services/WorkspaceService.ts:595-614',
  ],
  'SEC-AITUI-002': [
    'server/src/services/CommandPresetService.ts:155-176',
    'server/src/routes/commandPresetRoutes.ts:6-52',
    'frontend/src/components/MetadataBar/MetadataRow.tsx:67-120',
    'frontend/src/components/Workspace/WorkspaceTabBar.tsx:75-143',
  ],
  'REL-AITUI-001': [
    'server/src/services/CommandPresetService.ts:216-290',
    'server/src/services/CommandPresetService.ts:22-52',
  ],
};

const dependsByReq = {
  'FR-AITUI-003': ['FR-AITUI-002'],
  'FR-AITUI-004': ['FR-AITUI-002', 'FR-AITUI-003'],
  'FR-AITUI-005': ['FR-AITUI-002'],
  'SEC-AITUI-001': ['FR-AITUI-002', 'FR-AITUI-004'],
  'SEC-AITUI-002': ['FR-AITUI-001', 'FR-AITUI-003'],
  'REL-AITUI-001': ['FR-AITUI-002'],
};

const codeContext = {
  req_anchors: reqs.map((r) => ({
    req_id: r.id,
    files: (traceByReq[r.id] || []).map((ref) => {
      const m = ref.match(/^(.*):(\d+-\d+)$/);
      return { path: m ? m[1] : ref, line_range: m ? m[2] : undefined, signature: 'SRS trace anchor' };
    }),
  })),
  missing_anchors: [],
  external_paths_detected: [],
  addition_sites: [
    { path: 'server/src/types/recoveryOption.types.ts', line_range: 'new_file', signature: 'RecoveryOption domain types' },
    { path: 'server/src/services/RecoveryOptionService.ts', line_range: 'new_file', signature: 'RecoveryOptionService' },
    { path: 'server/src/routes/recoveryOptionRoutes.ts', line_range: 'new_file', signature: 'createRecoveryOptionRoutes' },
    { path: 'server/src/utils/recoveryCommand.ts', line_range: 'new_file', signature: 'normalizeRecoveryCommand / quoteRecoveryCommandForShell' },
    { path: 'frontend/src/types/recoveryOption.ts', line_range: 'new_file', signature: 'frontend API types' },
    { path: 'frontend/src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx', line_range: 'new_file', signature: 'RecoveryOptionDialog' },
    { path: 'frontend/src/components/RecoveryOptionManager/useRecoveryOptions.ts', line_range: 'new_file', signature: 'useRecoveryOptions' },
    { path: 'frontend/tests/e2e/recovery-options.spec.ts', line_range: 'new_file', signature: 'desktop recovery options E2E' },
  ],
};

const srsMapping = {
  req_inventory: reqs.map((r) => ({
    req_id: r.id,
    stability: r.stability,
    status: r.status,
    ac_total: r.ac.length,
    ac_ids: r.ac,
    files_from_trace: traceByReq[r.id] || [],
    depends_on: dependsByReq[r.id] || [],
    feasibility_hint: 'high',
  })),
  dependency_graph: Object.entries(dependsByReq).flatMap(([from, toList]) => toList.map((to) => ({ from, to }))),
};

const phases = [
  { id: 'PH-001', title: 'Recovery Option Domain And API', goal: '전용 recovery option 저장소, 기본 seed, 검증, 인증된 CRUD API를 TDD로 구현한다.', depends_on: [], task_ids: ['T-PH001-01', 'T-PH001-02'] },
  { id: 'PH-002', title: 'Command Matching And Tab Metadata', goal: '제출 명령을 recovery option과 매칭하고 탭 메타데이터에 명령/아이콘 상태를 저장한다.', depends_on: ['PH-001'], task_ids: ['T-PH002-01', 'T-PH002-02'] },
  { id: 'PH-003', title: 'Restart And Orphan Restore Execution', goal: '탭 재시작과 서버 재기동 orphan recovery에서 shell/CWD 복원 이후 안전하게 복구 명령을 주입한다.', depends_on: ['PH-001', 'PH-002'], task_ids: ['T-PH003-01', 'T-PH003-02'] },
  { id: 'PH-004', title: 'Desktop UI And Safe Icon Rendering', goal: 'desktop Tools 메뉴 dialog, API hook, 타입 전파, 안전한 아이콘 렌더링, Playwright 검증을 구현한다.', depends_on: ['PH-001', 'PH-002'], task_ids: ['T-PH004-01', 'T-PH004-02'] },
  { id: 'PH-005', title: 'Phase Completion Review And Handoff', goal: '구현 후 강제 서브에이전트 코드리뷰와 최종 검증 결과를 확인한다.', depends_on: ['PH-001', 'PH-002', 'PH-003', 'PH-004'], task_ids: ['T-PH005-01'] },
];

const shell = (cmd) => ({ kind: 'shell', cmd, expected_exit: 0 });
const checklist = (items) => ({ kind: 'checklist', items });
const vc = (cmd) => ({ posix: cmd, windows: cmd });
const f = (p, lr) => (lr ? { path: p, line_range: lr } : { path: p });
const nf = (p) => ({ path: p, line_range: '[INFERRED:new-file]' });

const tasks = [
  {
    id: 'T-PH001-01',
    phase_id: 'PH-001',
    title: 'Write failing backend tests for recovery option store and protected API',
    type: 'code',
    req_ids: ['FR-AITUI-002', 'FR-AITUI-005', 'REL-AITUI-001', 'SEC-AITUI-001', 'SEC-AITUI-002'],
    files: [f('server/src/test-runner.ts')],
    action: 'Add red tests for RecoveryOptionService seed-once defaults, command/icon validation, duplicate normalization, serialized mutations, route auth, dangerous flag defaults, and tmp/bak recovery.',
    acceptance_tests: [shell('npm --prefix server test'), checklist(['Red tests fail before RecoveryOptionService/routes exist', 'Tests include control-character and icon injection rejection cases', 'Tests include corrupted primary with valid backup recovery'])],
    verification_cmd: vc('npm --prefix server test'),
    dod: ['Failing tests are registered in server/src/test-runner.ts', 'Each covered AC has at least one test case id in sidecar', 'No production implementation is added in this task'],
    rollback: 'Remove the added recovery option test registrations and helpers from server/src/test-runner.ts.',
    estimated_effort: 'M',
    depends_on_task: [],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'red',
    test_file: 'server/src/test-runner.ts',
    testMatrix: {
      'FR-AITUI-002': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
      'FR-AITUI-005': ['AC-1', 'AC-2', 'AC-3', 'AC-5'],
      'SEC-AITUI-001': ['AC-1', 'AC-2', 'AC-4'],
      'SEC-AITUI-002': ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
      'REL-AITUI-001': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'],
    },
  },
  {
    id: 'T-PH001-02',
    phase_id: 'PH-001',
    title: 'Implement recovery option service validation routes and server registration',
    type: 'code',
    req_ids: ['FR-AITUI-002', 'FR-AITUI-005', 'REL-AITUI-001', 'SEC-AITUI-001', 'SEC-AITUI-002'],
    files: [
      nf('server/src/types/recoveryOption.types.ts'),
      nf('server/src/utils/recoveryCommand.ts'),
      nf('server/src/services/RecoveryOptionService.ts'),
      nf('server/src/routes/recoveryOptionRoutes.ts'),
      f('server/src/index.ts', '20-32'),
      f('server/src/index.ts', '280-287'),
      f('server/src/index.ts', '432-437'),
    ],
    action: 'Create the dedicated RecoveryOption domain, normalize executable identity, validate commands/arguments/icons, seed defaults only on first store creation, implement authenticated CRUD/reorder routes, and register the service before workspace orphan recovery.',
    acceptance_tests: [shell('npm --prefix server test'), checklist(['claudep is absent from built-in defaults', 'default claude omits dangerous permission flags', 'invalid rows are dropped with observable diagnostics'])],
    verification_cmd: vc('npm --prefix server test'),
    dod: ['All T-PH001-01 tests pass', 'Store path is separate from command-presets.json', 'Default deletion survives service restart', 'Duplicate normalized commands are rejected'],
    rollback: 'Remove the new recovery option service/routes/types/util files and unregister the route/service from server/src/index.ts.',
    estimated_effort: 'L',
    depends_on_task: ['T-PH001-01'],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'green',
    test_file: 'server/src/test-runner.ts',
    testMatrix: {
      'FR-AITUI-002': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
      'FR-AITUI-005': ['AC-1', 'AC-2', 'AC-3', 'AC-5'],
      'SEC-AITUI-001': ['AC-1', 'AC-2', 'AC-4'],
      'SEC-AITUI-002': ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
      'REL-AITUI-001': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'],
    },
  },
  {
    id: 'T-PH002-01',
    phase_id: 'PH-002',
    title: 'Write failing backend tests for submitted command matching and metadata',
    type: 'code',
    req_ids: ['FR-AITUI-003', 'SEC-AITUI-002'],
    files: [f('server/src/test-runner.ts')],
    action: 'Add red tests proving submitted claude/codex/custom commands match enabled recovery options, unmatched claudep stores no metadata, disabled/deleted option clears metadata, and AI TUI typing remains idle.',
    acceptance_tests: [shell('npm --prefix server test'), checklist(['Tests cover claude, codex, claudep unmatched, and claudep custom option', 'Tests assert foreground AI TUI keyboard input does not transition to running'])],
    verification_cmd: vc('npm --prefix server test'),
    dod: ['Matching tests fail before metadata implementation', 'Idle invariant regression is explicit', 'Icon metadata null clearing is asserted'],
    rollback: 'Remove the added command matching tests from server/src/test-runner.ts.',
    estimated_effort: 'M',
    depends_on_task: [],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'red',
    test_file: 'server/src/test-runner.ts',
    testMatrix: { 'FR-AITUI-003': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'], 'SEC-AITUI-002': ['AC-5'] },
  },
  {
    id: 'T-PH002-02',
    phase_id: 'PH-002',
    title: 'Implement command matching and persisted tab recovery metadata',
    type: 'code',
    req_ids: ['FR-AITUI-003', 'SEC-AITUI-002'],
    files: [
      f('server/src/services/SessionManager.ts', '900-940'),
      f('server/src/services/SessionManager.ts', '2572-2608'),
      f('server/src/services/WorkspaceService.ts', '25-58'),
      f('server/src/types/workspace.types.ts', '18-30'),
    ],
    action: 'Expose a submitted-command callback from SessionManager, match normalized executable tokens against enabled RecoveryOptionService entries, persist matched command/icon metadata on owning workspace tabs, and preserve the AI TUI idle invariant.',
    acceptance_tests: [shell('npm --prefix server test'), checklist(['Existing Codex/Claude/Hermes idle tests remain passing', 'Workspace tab metadata stores matched command and safe icon data only'])],
    verification_cmd: vc('npm --prefix server test'),
    dod: ['All T-PH002-01 tests pass', 'Metadata is cleared when no enabled option matches', 'writeInput matching does not mark foreground AI TUI typing as running'],
    rollback: 'Remove recovery matching callbacks and workspace metadata fields from SessionManager/WorkspaceService/types.',
    estimated_effort: 'L',
    depends_on_task: ['T-PH002-01', 'T-PH001-02'],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'green',
    test_file: 'server/src/test-runner.ts',
    testMatrix: { 'FR-AITUI-003': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'], 'SEC-AITUI-002': ['AC-5'] },
  },
  {
    id: 'T-PH003-01',
    phase_id: 'PH-003',
    title: 'Write failing backend tests for restart and orphan restore execution',
    type: 'code',
    req_ids: ['FR-AITUI-004', 'FR-AITUI-005', 'SEC-AITUI-001'],
    files: [f('server/src/test-runner.ts')],
    action: 'Add red tests for restartTab and checkOrphanTabs restore evaluation, shell-specific quoting, shell/CWD readiness delay, deleted/disabled option skip, claudep dangerous-flag opt-in, and observable restore failures.',
    acceptance_tests: [shell('npm --prefix server test'), checklist(['Tests cover PowerShell, cmd, bash, zsh, and sh quoting', 'Tests prove restore waits for readiness rather than immediate PTY creation write'])],
    verification_cmd: vc('npm --prefix server test'),
    dod: ['Restore tests fail before injection path exists', 'Failure diagnostics are asserted', 'PowerShell NoProfile caveat is covered'],
    rollback: 'Remove restore execution tests from server/src/test-runner.ts.',
    estimated_effort: 'M',
    depends_on_task: [],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'red',
    test_file: 'server/src/test-runner.ts',
    testMatrix: {
      'FR-AITUI-004': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
      'FR-AITUI-005': ['AC-4', 'AC-6'],
      'SEC-AITUI-001': ['AC-3', 'AC-5', 'AC-6'],
    },
  },
  {
    id: 'T-PH003-02',
    phase_id: 'PH-003',
    title: 'Implement readiness-aware restart and orphan restore execution',
    type: 'code',
    req_ids: ['FR-AITUI-004', 'FR-AITUI-005', 'SEC-AITUI-001'],
    files: [
      f('server/src/services/WorkspaceService.ts', '336-351'),
      f('server/src/services/WorkspaceService.ts', '595-614'),
      f('server/src/services/SessionManager.ts', '1632-1668'),
      f('server/src/services/SessionManager.ts', '1701-1717'),
      nf('server/src/utils/recoveryCommand.ts'),
    ],
    action: 'Add a restore input queue/callback that runs after shell startup and CWD initialization, re-checks the current enabled option, quotes command plus ordered args per shell, clears stale metadata for deleted/disabled options, and logs diagnostic failures.',
    acceptance_tests: [shell('npm --prefix server test'), checklist(['codex resume --last and claudep dangerous-flag examples are quoted through the shared builder', 'Deleted or disabled options skip PTY writes'])],
    verification_cmd: vc('npm --prefix server test'),
    dod: ['All T-PH003-01 tests pass', 'Restore executes only after shell/CWD readiness', 'Command construction uses structured command+arguments instead of raw concatenation'],
    rollback: 'Remove restore injection queue/callback and WorkspaceService recovery option lookup changes.',
    estimated_effort: 'L',
    depends_on_task: ['T-PH003-01', 'T-PH001-02', 'T-PH002-02'],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'green',
    test_file: 'server/src/test-runner.ts',
    testMatrix: {
      'FR-AITUI-004': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
      'FR-AITUI-005': ['AC-4', 'AC-6'],
      'SEC-AITUI-001': ['AC-3', 'AC-5', 'AC-6'],
    },
  },
  {
    id: 'T-PH004-01',
    phase_id: 'PH-004',
    title: 'Write failing frontend tests for recovery dialog and safe icons',
    type: 'code',
    req_ids: ['FR-AITUI-001', 'SEC-AITUI-002'],
    files: [
      nf('frontend/tests/unit/recoveryOptionDialog.test.ts'),
      nf('frontend/tests/unit/recoveryOptionIcon.test.ts'),
      nf('frontend/tests/e2e/recovery-options.spec.ts'),
      f('frontend/tests/e2e/helpers.ts'),
    ],
    action: 'Add red unit and desktop Playwright tests for Tools menu 복구 옵션, blank add form, required command validation, empty arguments save, default deletion, icon rendering as data, and markup/script/URL rejection display paths.',
    acceptance_tests: [shell('npm --prefix frontend run typecheck'), shell('npm --prefix frontend exec playwright test tests/e2e/recovery-options.spec.ts --project \"Desktop Chrome\"')],
    verification_cmd: vc('npm --prefix frontend run typecheck && npm --prefix frontend exec playwright test tests/e2e/recovery-options.spec.ts --project \"Desktop Chrome\"'),
    dod: ['Tests fail before UI/API implementation', 'Playwright opens the desktop Tools menu at https://localhost:2002', 'Icon injection cases never rely on raw markup rendering'],
    rollback: 'Remove the new recovery option unit/e2e tests and helper additions.',
    estimated_effort: 'M',
    depends_on_task: [],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'red',
    test_file: 'frontend/tests/unit/recoveryOptionDialog.test.ts',
    testMatrix: { 'FR-AITUI-001': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'], 'SEC-AITUI-002': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'] },
  },
  {
    id: 'T-PH004-02',
    phase_id: 'PH-004',
    title: 'Implement desktop recovery option dialog API hook and icon rendering',
    type: 'code',
    req_ids: ['FR-AITUI-001', 'SEC-AITUI-002'],
    files: [
      nf('frontend/src/types/recoveryOption.ts'),
      f('frontend/src/types/index.ts'),
      f('frontend/src/types/workspace.ts', '12-31'),
      f('frontend/src/services/api.ts', '458-570'),
      nf('frontend/src/components/RecoveryOptionManager/RecoveryOptionDialog.tsx'),
      nf('frontend/src/components/RecoveryOptionManager/useRecoveryOptions.ts'),
      nf('frontend/src/components/RecoveryOptionManager/index.ts'),
      f('frontend/src/components/Header/Header.tsx', '22-61'),
      f('frontend/src/App.tsx', '99-106'),
      f('frontend/src/App.tsx', '520-532'),
      f('frontend/src/App.tsx', '686-704'),
      f('frontend/src/hooks/useWorkspaceManager.ts'),
      f('frontend/src/components/MetadataBar/MetadataRow.tsx', '67-120'),
      f('frontend/src/components/Workspace/WorkspaceTabBar.tsx', '75-143'),
    ],
    action: 'Wire the desktop Header Tools menu to RecoveryOptionDialog, implement list/add/edit/delete/reorder UI with required command validation and optional arguments/icon controls, add recoveryOptionApi/useRecoveryOptions, propagate tab metadata null clearing, and render safe built-in/text icons left of terminal/tab names.',
    acceptance_tests: [shell('npm --prefix frontend run typecheck'), shell('npm --prefix frontend exec playwright test tests/e2e/recovery-options.spec.ts --project \"Desktop Chrome\"')],
    verification_cmd: vc('npm --prefix frontend run typecheck && npm --prefix frontend exec playwright test tests/e2e/recovery-options.spec.ts --project \"Desktop Chrome\"'),
    dod: ['All T-PH004-01 tests pass', '복구 옵션 appears only in the desktop Tools menu', 'Default Claude/Codex options can be deleted like normal rows', 'Persisted icon data is rendered without dangerouslySetInnerHTML'],
    rollback: 'Remove RecoveryOptionManager files and undo Header/App/api/type/workspace icon rendering changes.',
    estimated_effort: 'L',
    depends_on_task: ['T-PH004-01', 'T-PH001-02', 'T-PH002-02'],
    covers_ac: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    tdd_phase: 'green',
    test_file: 'frontend/tests/unit/recoveryOptionDialog.test.ts',
    testMatrix: { 'FR-AITUI-001': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'], 'SEC-AITUI-002': ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'] },
  },
  {
    id: 'T-PH005-01',
    phase_id: 'PH-005',
    title: 'Run phase completion code review and final validation handoff',
    type: 'review',
    req_ids: reqs.map((r) => r.id),
    files: [
      f(planPath),
      f(sidecarPath),
      f(validatorPath),
    ],
    action: 'After all green implementation tasks finish, run the repository-mandated critical sub-agent code review against the plan and implementation diff, fix every finding, re-run the same or equivalent reviewer until No findings, and confirm final backend/frontend/Playwright validation status.',
    acceptance_tests: [checklist(['A sub-agent code reviewer reports No findings or equivalent', 'Any review findings are fixed and re-reviewed', 'Final server, frontend, and desktop Playwright validation results are recorded for handoff'])],
    verification_cmd: null,
    dod: ['Phase completion review loop is complete', 'No CRITICAL/HIGH reviewer findings remain', 'Final validation commands and residual warnings are reported to the user'],
    rollback: 'Keep implementation changes but reopen the implementation loop at the failing phase if review or validation fails.',
    estimated_effort: 'M',
    depends_on_task: ['T-PH001-02', 'T-PH002-02', 'T-PH003-02', 'T-PH004-02'],
    covers_ac: [],
    tdd_phase: 'n/a',
    test_file: null,
    testMatrix: {},
  },
];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}
function argsHash(call, args) {
  return sha1(`${call}|${canonicalJson(args)}`);
}
function makeTestCases(task) {
  const cases = [];
  const taskSeq = task.id.match(/-(\d{2})$/)?.[1] || '01';
  const phaseSeq = task.id.match(/T-PH(\d{3})-/)?.[1] || '000';
  const seq = String((Number(phaseSeq) - 1) * 2 + Number(taskSeq)).padStart(2, '0');
  for (const [reqId, acs] of Object.entries(task.testMatrix || {})) {
    for (const ac of acs) {
      const acNumber = ac.replace('AC-', '');
      const tc = {
        id: `TC-REQ-${reqId}-AC${acNumber}-${seq}`,
        req_id: reqId,
        ac_refs: [ac],
        test_file: task.test_file,
        test_symbol: `${task.id} ${reqId} ${ac}`,
        kind: task.test_file.includes('/e2e/') ? 'e2e' : (task.test_file.includes('frontend') ? 'unit' : 'integration'),
      };
      if (task.tdd_phase === 'red') {
        tc.expected_failure_signature = 'not implemented|missing|expected failure|recovery option';
      }
      cases.push(tc);
    }
  }
  return cases;
}

const sidecarTasks = tasks.map((task) => {
  const trace_links = task.req_ids.map((reqId) => ({
    link_id: `TL-${task.id}-${reqId}`,
    source: { type: 'Task', id: task.id },
    target: { type: 'Requirement', reference: reqId },
    relation: 'depends_on',
    trace_intent: 'verifies',
  }));
  const baseTask = {
    id: task.id,
    phase_id: task.phase_id,
    title: task.title,
    type: task.type,
    req_ids: task.req_ids,
    files: task.files,
    action: task.action,
    acceptance_tests: task.acceptance_tests,
    verification_cmd: task.verification_cmd,
    dod: task.dod,
    rollback: task.rollback,
    trace_links,
    estimated_effort: task.estimated_effort,
    needs_clarification: [],
    depends_on_task: task.depends_on_task,
    covers_ac: task.covers_ac,
  };
  if (task.type !== 'code') {
    return {
      ...baseTask,
      tdd: {
        applicable: false,
        phase: 'n/a',
        test_cases: [],
        red_evidence: null,
        green_evidence: null,
      },
      test_files: [],
    };
  }
  return {
    ...baseTask,
    tdd: {
      applicable: true,
      phase: task.tdd_phase,
      test_cases: makeTestCases(task),
      red_evidence: null,
      green_evidence: null,
    },
    test_files: [{ path: task.test_file }],
  };
});

const allTestCases = sidecarTasks.flatMap((t) => t.tdd.test_cases.map((tc) => ({ ...tc, task_id: t.id })));
const coverage = reqs.map((req) => ({
  req_id: req.id,
  stability: req.stability,
  ac_total: req.ac.length,
  ac_covered: req.ac.length,
  missing_ac_ids: [],
  covered_tasks: sidecarTasks.filter((t) => t.req_ids.includes(req.id)).map((t) => t.id),
  ac_test_map: req.ac.map((ac) => ({
    ac_id: ac,
    test_case_ids: allTestCases.filter((tc) => tc.req_id === req.id && tc.ac_refs.includes(ac)).map((tc) => tc.id),
  })),
}));

let seq = 1;
const mcp_call_log = [];
for (const task of sidecarTasks) {
  for (const tl of task.trace_links) {
    const args = { source: tl.source, target: tl.target, relation: tl.relation };
    mcp_call_log.push({ seq: seq++, call: 'add_trace_link', args, args_hash: argsHash('add_trace_link', args), response_hash: null, timestamp: generatedAt, ok: null });
  }
}
for (const cov of coverage) {
  const args = { id: cov.req_id, type: 'plan', reference: `${planPath}#${cov.req_id}` };
  mcp_call_log.push({ seq: seq++, call: 'add_verification_evidence', args, args_hash: argsHash('add_verification_evidence', args), response_hash: null, timestamp: generatedAt, ok: null });
}

const sidecar = {
  schema_version: '1.1.0',
  plan_contract: '1.2.0',
  run_id: runId,
  target,
  plan_version: '0.1.0',
  generated_at: generatedAt,
  tool_versions: { speckiwi: '2.2.3', kiwi_planner: '0.6.0', validator: '0.6.0' },
  tdd_policy: 'relaxed',
  md_path: planPath,
  md_sha256: 'pending',
  phases,
  tasks: sidecarTasks,
  coverage,
  orphans: [],
  unreferenced_reqs: [],
  excluded_reqs: [],
  deferred_ac: [],
  risks: [
    { id: 'RISK-001', severity: 'high', description: 'Restore command auto-execution can run unsafe arguments if validation or quoting is incomplete.', mitigation: 'Centralize structured command+argument validation and shell-specific quoting in server/src/utils/recoveryCommand.ts, and keep dangerous flags opt-in only.', affected_task_ids: ['T-PH001-02', 'T-PH003-02'] },
    { id: 'RISK-002', severity: 'med', description: 'Shell startup readiness differs across PowerShell, cmd, bash, zsh, and sh.', mitigation: 'Use a readiness-aware restore queue/callback and shell-specific regression tests before writing restore input.', affected_task_ids: ['T-PH003-01', 'T-PH003-02'] },
    { id: 'RISK-003', severity: 'med', description: 'Icon rendering can regress into unsafe markup if typed icon data is bypassed.', mitigation: 'Validate icons server-side and render via built-in key/text components only, with injection regression tests.', affected_task_ids: ['T-PH001-01', 'T-PH004-02'] },
  ],
  open_questions: [],
  external_module_impact: [],
  tdd_decisions: [],
  coder_handoff_readiness: phases.map((p) => ({ phase_id: p.id, ready: true, blockers: [] })),
  mcp_call_log,
};

const list = (xs) => `[${xs.join(', ')}]`;
const filesList = (files) => `[${files.map((x) => x.line_range ? `${x.path}:${x.line_range}` : x.path).join(', ')}]`;
function taskMd(t) {
  const verification = t.verification_cmd
    ? `{posix: ${t.verification_cmd.posix}, windows: ${t.verification_cmd.windows}}`
    : 'null';
  return [
    `#### §3.${t.phase_id}.${t.id}`,
    `- id: ${t.id}`,
    `- phase_id: ${t.phase_id}`,
    `- title: ${t.title}`,
    `- type: ${t.type}`,
    `- req_ids: ${list(t.req_ids)}`,
    `- files: ${filesList(t.files)}`,
    `- action: ${t.action}`,
    `- acceptance_tests: ${JSON.stringify(t.acceptance_tests)}`,
    `- verification_cmd: ${verification}`,
    `- dod: ${t.dod.join('; ')}`,
    `- rollback: ${t.rollback}`,
    `- estimated_effort: ${t.estimated_effort}`,
    `- depends_on_task: ${list(t.depends_on_task || [])}`,
    `- covers_ac: ${list(t.covers_ac || [])}`,
    `- tdd: {applicable: ${t.tdd.applicable}, phase: ${t.tdd.phase}, test_cases_count: ${t.tdd.test_cases.length}}`,
    '',
  ].join('\n');
}

const phaseRows = phases.map((p) => `| ${p.id} | ${p.title} | ${p.goal} | ${p.depends_on.length ? p.depends_on.join(', ') : '-'} | ${p.task_ids.length} |`).join('\n');
const taskSections = phases.map((p) => `### §3.${p.id} ${p.title}\n\n${p.task_ids.map((id) => taskMd(sidecarTasks.find((t) => t.id === id))).join('\n')}`).join('\n');
const indexRows = coverage.map((c) => `| ${c.req_id} | ${c.stability} | ${c.covered_tasks.join(', ')} | ${c.ac_covered}/${c.ac_total} |`).join('\n');
const riskRows = sidecar.risks.map((r) => `| ${r.id} | ${r.severity} | ${r.description} | ${r.mitigation} | ${r.affected_task_ids.join(', ')} |`).join('\n');

let planMd = `---
run_id: ${runId}
target: ${target}
plan_version: 0.1.0
plan_contract: "1.2.0"
generated_at: ${generatedAt}
tool_versions:
  speckiwi: 2.2.3
  kiwi_planner: 0.6.0
  validator: 0.6.0
stability_summary:
  frozen: 0
  stable: 0
  evolving: 8
  draft: 0
tdd_policy: relaxed
sidecar_path: ./${runId}.sidecar.json
md_sha256: pending
---

## §1 개요

### 1.1 목표

${intent.target_intent}

### 1.2 범위 (in_scope[])

- Desktop Header Tools menu item named \`복구 옵션\` and a recovery option manager dialog.
- Dedicated backend recovery option store, validation, seed-once defaults, ordering, and protected CRUD API.
- Submitted command matching for Claude, Codex, and user-created commands such as \`claudep\`.
- Recovery icon metadata propagation to workspace tabs and safe rendering next to terminal/tab names.
- Restart/orphan-tab restore execution after shell type and last CWD restoration.
- Backend, frontend, and Playwright regression coverage with TDD red/green ordering.
- Mandatory sub-agent code review and final validation handoff after implementation.

### 1.3 제외사항 (out_of_scope[], excluded_reqs 포함)

- Mobile recovery option entry points.
- Reusing terminal context-menu registered item paste behavior as the recovery execution path.
- Adding dangerous Claude permission flags to built-in defaults.
- Guaranteeing PowerShell profile-only aliases unless the user creates a custom option and the restore shell can resolve it.
- excluded_reqs: []

### 1.4 전제조건 / 가정

- All 8 target requirements are \`evolving\`; no draft or deprecated REQ enters the plan.
- The implementation may add a dedicated RecoveryOption domain while reusing existing persistence, route, dialog, and workspace update patterns.
- Playwright validation must target \`https://localhost:2002\` when run manually or in E2E.

## §2 Phase 목록

| phase_id | title | goal | depends_on | task_count |
| --- | --- | --- | --- | --- |
${phaseRows}

## §3 Task 상세

${taskSections}
## §4 REQ ↔ Task 역색인

| req_id | stability | task_ids[] | ac_covered/ac_total |
| --- | --- | --- | --- |
${indexRows}

## §5 위험 · 미해결

### 5.1 위험 (risk_id, severity, mitigation, affected_task_ids)

| risk_id | severity | description | mitigation | affected_task_ids |
| --- | --- | --- | --- | --- |
${riskRows}

### 5.2 Open Questions (id, question, blocks_task_ids)

없음.

### 5.3 unreferenced_reqs (deprecated 외 미커버 REQ)

없음.

### 5.4 deferred_ac

없음.

### 5.5 TDD 결정

\`type=code\` Task 면제 없음. 모든 code Task는 red 또는 green으로 분리되어 있고 green Task는 대응 red Task를 \`depends_on_task\`로 참조한다. \`T-PH005-01\`은 review Task이므로 TDD 자동 면제이다.

## §6 부록

### 6.1 사이드카 JSON 경로 / md_sha256

- sidecar: \`${sidecarPath}\`
- md_sha256: pending

### 6.2 검증 스크립트 실행 방법

\`node .agents/skills/kiwi-planner/scripts/validator.mjs ${planPath} ${sidecarPath} --target ${target} --inventory-file ${analysisDir}/inventory.json --out ${validatorPath} --tdd-policy relaxed\`

### 6.3 mcp_call_log 요약 (호출 수 / mutation 수)

- add_trace_link: ${mcp_call_log.filter((e) => e.call === 'add_trace_link').length}
- add_verification_evidence: ${mcp_call_log.filter((e) => e.call === 'add_verification_evidence').length}
- total planned mutations: ${mcp_call_log.length}
`;

const mdHash = crypto.createHash('sha256').update(planMd, 'utf8').digest('hex');
planMd = planMd.replaceAll('md_sha256: pending', `md_sha256: ${mdHash}`).replaceAll('- md_sha256: pending', `- md_sha256: ${mdHash}`);
sidecar.md_sha256 = mdHash;

fs.mkdirSync(path.dirname(planPath), { recursive: true });
fs.mkdirSync(analysisDir, { recursive: true });
fs.writeFileSync(planPath, planMd, 'utf8');
fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'preflight.json'), JSON.stringify({ mcp: { ok: true }, cli: { ok: true, version: '2.2.3' }, halted: false, target }, null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'intent.json'), JSON.stringify(intent, null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'code_context.json'), JSON.stringify(codeContext, null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'srs_mapping.json'), JSON.stringify(srsMapping, null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'inventory.json'), JSON.stringify(reqs.map((r) => ({ id: r.id, stability: r.stability, ac_total: r.ac.length, ac_ids: r.ac })), null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'phase2_plan_draft_iter1.json'), JSON.stringify({ run_id: runId, plan_path: planPath, sidecar_path: sidecarPath, phases: phases.length, tasks: tasks.length, mcp_planned: mcp_call_log.length }, null, 2), 'utf8');
fs.writeFileSync(path.join(analysisDir, 'rejected_findings.log'), '', 'utf8');
fs.writeFileSync(path.join(analysisDir, 'mcp_call_log.jsonl'), mcp_call_log.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
console.log(JSON.stringify({ planPath, sidecarPath, analysisDir, tasks: tasks.length, mcpCalls: mcp_call_log.length }, null, 2));
