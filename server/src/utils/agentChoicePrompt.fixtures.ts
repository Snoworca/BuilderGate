// FR-AITUI-024: real agent screens, captured 2026-11-16 by driving the CLIs in a
// private PTY into @xterm/headless (100x32): Claude Code v2.1.325 and
// codex-cli 0.167.0. Machine paths and probe folder names are replaced.
// Do not edit a captured screen to make a test pass: capture a new one.
/* eslint-disable */

export const CAPTURED_POSITIVE_SCREENS: Record<string, string> = {
  claudeTrustFolder: "\n────────────────────────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n C:\\work\\probe\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a\n well-known open source project, or work from your team). If not, take a moment to review what's in\n this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel",
  claudeTrustFolderMoved: "\n────────────────────────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n C:\\work\\probe\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a\n well-known open source project, or work from your team). If not, take a moment to review what's in\n this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel",
  claudeAskUserQuestion: "\n ▐▛███▛█   Claude Code v2.1.325\n▝▜██████▀  Haiku 5.5 · Claude Ultra\n ▝▝   ▝▝   ~\\work\\probe\n\n\n❯ Use the Bash tool to run exactly this command: echo awaiting-probe . Do nothing else.\n\n  Ran 1 shell command\n\n● echo awaiting-probe 명령을 실행했고, 출력은 awaiting-probe입니다.\n\n✻ Cooked for 1m 5s · done 오전 10:00\n\n❯ Use the AskUserQuestion tool to ask me which color I prefer, with the options Red and Blue.\n────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ 색상 선호\n\n어떤 색을 선호하시나요?\n\n❯ 1. Red\n     빨간색을 선택합니다.\n  2. Blue\n     파란색을 선택합니다.\n  3. Type something.\n────────────────────────────────────────────────────────────────────────────────────────────────────\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  claudeCreateFilePermission: "\n ▐▛███▛█   Claude Code v2.1.325\n▝▜██████▀  Haiku 5.5 · Claude Ultra\n ▝▝   ▝▝   ~\\work\\probe\n\n\n❯ Use the Write tool to create a file named probe.txt that contains the word hi. Do nothing else.\n\n● Write(probe.txt)\n\n────────────────────────────────────────────────────────────────────────────────────────────────────\n Create file\n probe.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n  1 hi\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create probe.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this\n      session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend",
  // Captured 2026-11-17 in an environment like the 2002 daemon: no TERM, WT_SESSION or
  // TERM_PROGRAM, so Claude Code falls back to ASCII figures and its menu cursor is '>'.
  claudeTrustFolderAscii: "\n C:\\work\\probe\n\n Quick safety check: Is this a project you created or one you trust? (Like your\n own code, a well-known open source project, or work from your team). If not,\n take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n > No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel",
  // Captured 2026-11-18 from two live sessions on the 2002 daemon (0.11.7) with the
  // BuilderGate MCP terminal.read, where the badge did not show. terminal.read joins a
  // full-width rule with the row after it, so those rows are split back here; the rules
  // are written with repeat() instead of 200 literal characters. Three described options,
  // the question bar of a multi-question form, and the border a named (-n) session draws
  // under the footer: ten rows below the cursor.
  claudeAskUserQuestionThreeOptionsNamedSession: [
    '  7. 이후 진행: 답을 주시면 병합 승인을 요청할 때까지 더 묻지 않고 진행합니다.',
    '─'.repeat(200),
    '←  ☐ 회수 범위  ☐ 범위  ✔ Submit  →',
    '',
    '│ #2221: 관리 화면(회원 상세 「토큰 대신 발급」)은 어떤 회수 범위로 발급할까요? 서버 #6147 이후 revokeScope 를 빼면 같은 이름(label)의 토큰만 교체됩니다.',
    '',
    '❯ 1. "all" 명시 — 지금 UX 유지 (권장)',
    '     회원 대상 발급에 revokeScope:"all" 을 보내 모두 회수 + 에이전트 연결 삭제. 확인 창 · 시안 05 문구 유지, 0.9.6 서버와도 동작 일치',
    '  2. 서버 기본(같은 이름만 교체)',
    '     인자를 빼고 확인 창 · 양식 순서와 문구, 멈추는 토큰 수 계산을 이름 기준으로 다시 설계(시안 05 변경)',
    '  3. 양식에서 관리자가 고름',
    '     「같은 이름만 교체 / 모두 회수」 선택지를 새로 두고 확인 문장도 나눔(새 UI 설계)',
    '  4. Type something.',
    '─'.repeat(200),
    '  5. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    `${'─'.repeat(180)} og-flow 지휘 2221 ─`,
  ].join('\n'),
  claudeAskUserQuestionFourQuestionFormNamedSession: [
    '  7. 이후 진행: 답을 주시면 병합 승인 요청까지 묻지 않고 진행합니다.',
    '─'.repeat(200),
    '←  ☐ 게시 동작  ☐ 일반 편집기  ☐ 이벤트 모양  ☐ 범위와 PR  ✔ Submit  →',
    '',
    '│ #2224 결정 1: 저장하지 않은 편집이 있을 때 게시 단추는 어떻게 동작해야 합니까? (임베드 캔버스에는 저장 단추가 없습니다)',
    '',
    '❯ 1. 먼저 저장 후 게시 (권장)',
    '     저장이 성공했을 때만 게시하고, 실패하거나 막히면 게시하지 않고 이유를 알립니다. 캔버스 안에서 바로 끝나는 유일한 안입니다.',
    '  2. 게시를 막고 안내',
    '     「먼저 저장하세요」라고만 알립니다. 임베드에서는 바깥 페이지가 ogEmbed.save() 를 불러야만 풀립니다.',
    '  3. 확인 창으로 고르기',
    '     「저장하고 게시」·「저장된 판만 게시」를 고르게 합니다. 게시에 창이 하나 늘어납니다.',
    '  4. Type something.',
    '─'.repeat(200),
    '  5. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    `${'─'.repeat(176)} og-flow 지휘 2224·2225 ─`,
  ].join('\n'),
  // Captured 2026-11-20 from "og-flow 2289" on the 2002 daemon (0.11.9) with the
  // BuilderGate MCP terminal.read, where the badge did not show. The tab was 43
  // columns wide (a phone), so the described options wrapped past the top of the
  // screen and the selected row "❯ 1." was no longer on it; a task panel of eight
  // rows sat under the footer. Rows terminal.read joined are split back.
  claudeAskUserQuestionCursorAboveScreenTaskPanel: [
    '     판정도 순서 비교 대신 값 집합 비교로',
    '     바꿉니다. 순서만 바꾼 줄은 다시 받은',
    '     목록으로 바뀝니다. 잃는 것은 서버에',
    '     저장되지 않는 표시 순서뿐입니다. 판정',
    '     함수 하나만 바꾸는 작은 변경이고, 세',
    '     번 되풀이된 같은 계열 결함의 원인(순서',
    '     비교와 값 집합 비교가 갈리는 것)을',
    '     없앱니다. FR-CREDOAUTH-051 AC-1 · AC-4',
    '     문장과 Rationale 을 고치고, 기존 045',
    '     AC-7 시험의 단언은 바꿀 필요가',
    '     없습니다.',
    '  2. 가. 한계로 기록',
    '     코드는 지금대로 둡니다. 051 AC-2 가',
    '     이미 기준 시각이 없는 창의 충돌 보호를',
    '     포기했고 지금 서버에서는 생기지 않는',
    '     창이므로, FR-CREDOAUTH-051 Rationale',
    '     에 선언된 한계 한 줄만 적고 병합 승인',
    '     요약에도 싣습니다.',
    '  3. 다. 기준 시각 없는 창만',
    '     기준 시각이 없는 창에서만 「다시',
    '     시도」 판정을 값 집합 비교로 바꿉니다.',
    '     기준 시각이 있는 창은 지금처럼',
    '     순서까지 비교합니다. 판정 규칙이 창',
    '     상태에 따라 둘로 나뉩니다.',
    '  4. Type something.',
    '─'.repeat(43),
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    `${'─'.repeat(28)} og-flow 2289 ─`,
    '',
    '  2/6 tasks done · 1 in progress',
    '  ◼ E3 셀프 리뷰 R1 · 독립 리뷰…',
    '  ◻ E4 실서버 화면 확인',
    '  ◻ E5~E9 증거 · 게이트 · PR · …',
    '  ◻ E10~E12 병합 승인 · 병합 · …',
    '  ✔ E1 SRS 마무리 · 커밋 · push',
    '  … +1 task (done)',
  ].join('\n'),
};

/**
 * Captured 2026-11-18 from "og-flow 지휘 2221" on 2002 after the user scrolled the
 * waiting menu: Claude Code draws it shifted up, the options below "4." and the
 * footer are off screen and a "Jump to bottom" rule takes their place. Rows that
 * terminal.read joined are split back; rules are written with repeat(). The menu is
 * still unanswered, so it must not read as the agent being back at its prompt.
 */
export const CAPTURED_SCROLLED_MENU_SCREEN = [
  '  7. 이후 진행: 답을 주시면 병합 승인을 요청할 때까지 더 묻지 않고 진행합니다.',
  `${'─'.repeat(200)}←  ☐ 회수 범위  ☐ 범위  ✔ Submit  →`,
  '│ #2221: 관리 화면(회원 상세 「토큰 대신 발급」)은 어떤 회수 범위로 발급할까요? 서버 #6147 이후 revokeScope 를 빼면 같은 이름(label)의 토큰만 교체됩니다.',
  '❯ 1. "all" 명시 — 지금 UX 유지 (권장)',
  '     회원 대상 발급에 revokeScope:"all" 을 보내 모두 회수 + 에이전트 연결 삭제. 확인 창 · 시안 05 문구 유지, 0.9.6 서버와도 동작 일치',
  '  2. 서버 기본(같은 이름만 교체)',
  '     인자를 빼고 확인 창 · 양식 순서와 문구, 멈추는 토큰 수 계산을 이름 기준으로 다시 설계(시안 05 변경)',
  '  3. 양식에서 관리자가 고름',
  '     「같은 이름만 교체 / 모두 회수」 선택지를 새로 두고 확인 문장도 나눔(새 UI 설계)',
  '  4. Type something.',
  `${'─'.repeat(90)} Jump to bottom (ctrl+End) ↓ ${'─'.repeat(80)}`,
  `${'─'.repeat(180)} og-flow 지휘 2221 ─`,
].join('\n');

export const CAPTURED_NEGATIVE_SCREENS: Record<string, string> = {
  claudeIdlePrompt: "\n ▐▛███▛█   Claude Code v2.1.325\n▝▜██████▀  Haiku 5.5 · Claude Ultra\n ▝▝   ▝▝   ~\\work\\probe\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n                                                                                ◐ medium · /effort\n────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ Try \"write a test for <filepath>\"\n────────────────────────────────────────────────────────────────────────────────────────────────────\n\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
  claudeTypedPrompt: "\n ▐▛███▛█   Claude Code v2.1.325\n▝▜██████▀  Haiku 5.5 · Claude Ultra\n ▝▝   ▝▝   ~\\work\\probe\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n                                                                                ◐ medium · /effort\n────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ Use the Bash tool to run exactly this command: echo awaiting-probe . Do nothing else.\n────────────────────────────────────────────────────────────────────────────────────────────────────\n\n  ⏵⏵ auto mode on (shift+tab to cycle)",
  claudeAfterDeclinedQuestion: "\n ▐▛███▛█   Claude Code v2.1.325\n▝▜██████▀  Haiku 5.5 · Claude Ultra\n ▝▝   ▝▝   ~\\work\\probe\n\n\n❯ Use the Bash tool to run exactly this command: echo awaiting-probe . Do nothing else.\n\n  Ran 1 shell command\n\n● echo awaiting-probe 명령을 실행했고, 출력은 awaiting-probe입니다.\n\n✻ Cooked for 1m 5s · done 오전 10:00\n\n❯ Use the AskUserQuestion tool to ask me which color I prefer, with the options Red and Blue.\n\n● User declined to answer questions\n  ⎿  · 어떤 색을 선호하시나요? (Red / Blue)\n\n✻ Cogitated for 4s · done 오전 10:01\n\n\n\n\n\n\n                                                                                ◐ medium · /effort\n────────────────────────────────────────────────────────────────────────────────────────────────────\n❯\n────────────────────────────────────────────────────────────────────────────────────────────────────\n  Bash 도구로 echo 명령 실행 |  probe  | Haiku 5.5 | ctx:35% | 7d:19% rst:11…\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
  claudeNumberedAnswer: "▝▜██████▀  Haiku 5.5 · Claude Ultra\n ▝▝   ▝▝   ~\\work\\probe\n\n\n❯ Use the Bash tool to run exactly this command: echo awaiting-probe . Do nothing else.\n\n  Ran 1 shell command\n\n● echo awaiting-probe 명령을 실행했고, 출력은 awaiting-probe입니다.\n\n✻ Cooked for 1m 5s · done 오전 10:00\n\n❯ Use the AskUserQuestion tool to ask me which color I prefer, with the options Red and Blue.\n\n● User declined to answer questions\n  ⎿  · 어떤 색을 선호하시나요? (Red / Blue)\n\n✻ Cogitated for 4s · done 오전 10:01\n\n❯ Reply with a numbered list of three fruits and nothing else.\n\n● 1. 사과\n  2. 바나나\n  3. 포도\n\n✻ Churned for 15s · done 오전 10:01\n\n────────────────────────────────────────────────────────────────────────────────────────────────────\n❯\n────────────────────────────────────────────────────────────────────────────────────────────────────\n  Bash 도구로 echo 명령 실행 |  probe  | Haiku 5.5 | ctx:36% | 7d:19% rst:11…\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
  codexStart: "",
  codexWorking: "\n  >_ OpenAI Codex (v0.167.0)\n     ~\\work\\probe\n\n  To get started, describe a task or try one of these commands:\n\n  /init - create an AGENTS.md file with instructions for Codex\n  /status - show current session configuration\n  /permissions - choose what Codex is allowed to do\n  /model - choose what model and reasoning effort to use\n  /review - review any changes and find issues\n\n\n› Run this shell command and nothing else: mkdir awaiting-probe\n\n\n\n\n\n\n\n\n\n\n• Working (39s • esc to interrupt)\n  └ Tip: Use /statusline to configure which items appear in the status line.\n\n\n› Ask Codex to do anything\n\n  GPT-6-Astra high · ~\\work\\probe\n  ← for agents · ? for shortcuts                                          ⚠ 5 warnings · f2 to view",
  codexInterrupted: "\n  >_ OpenAI Codex (v0.167.0)\n     ~\\work\\probe\n\n  To get started, describe a task or try one of these commands:\n\n  /init - create an AGENTS.md file with instructions for Codex\n  /status - show current session configuration\n  /permissions - choose what Codex is allowed to do\n  /model - choose what model and reasoning effort to use\n  /review - review any changes and find issues\n\n\n› Run this shell command and nothing else: mkdir awaiting-probe\n\n\n■ Conversation interrupted - use /feedback if something went wrong\n\n\n\n\n\n\n\n\n\n\n\n› Ask Codex to do anything\n\n  GPT-6-Astra high · ~\\work\\probe\n  ← for agents · ? for shortcuts                                          ⚠ 5 warnings · f2 to view",
  // Captured 2026-11-17 in an environment like the 2002 daemon: no TERM, WT_SESSION or
  // TERM_PROGRAM, so Claude Code falls back to ASCII figures and its menu cursor is '>'.
  claudeIdlePromptAscii: "\n\n\n\n\n\n\n\n\n\n\n                                                            ◐ medium · /effort\n────────────────────────────────────────────────────────────────────────────────> Try \"fix lint errors\"\n────────────────────────────────────────────────────────────────────────────────\n   probe  | Haiku 5.5\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 agents",
};
