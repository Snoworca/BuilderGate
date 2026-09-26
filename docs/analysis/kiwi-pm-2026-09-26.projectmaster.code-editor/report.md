# kiwi-pm report — 2026-09-26.projectmaster.code-editor

| 항목 | 값 |
|---|---|
| plan | docs/plans/2026-09-26.projectmaster.code-editor.plan.md |
| target | code-editor |
| Task | 32/32 done, failed 0, skipped 0, NEEDS_USER 0 |
| REQ | FR-MDE-013~019, IR-MDE-002, IR-MDE-003, SEC-MDE-001 → implemented (AC 전부 체크, test 증거 기준) |
| 회귀 | frontend unit 1630/1630, tsc app/test 0, vite build OK, server 관련 node:test 통과(기존 terminalWireFormat 3건 제외), test:release-pipeline 13/13 |
| E2E | code-editor-text 9 + code-editor-image 7 = 16/16, https://localhost:2222 (PID 107488, 이 체크아웃 server/dist) |
| 커밋 | 없음 |

## Task 결과

| Task | 상태 | 요약 |
|---|---|---|
| T-PH001-01 | done | IR-MDE-002/FR-MDE-016 테스트 6건, unknown 2건 의도된 red |
| T-PH001-02 | done | readFile fatal TextDecoder encoding utf-8|unknown, 테스트 11/11 |
| T-PH001-03 | done | editorLineEndings.test.ts 6건 red |
| T-PH001-04 | done | lineEndings.ts + EditorDocumentPanel sliceDoc 저장 경로, unit 1570/1570 |
| T-PH001-05 | done | editorDocumentAccess/readOnly 저장 테스트 5건 red |
| T-PH001-06 | done | editorDocumentAccess.ts, unknown→readOnly+안내, 줄바꿈 라벨, unit 1575/1575 |
| T-PH002-01 | done | editorMode.test.ts 8건 red; cfg/conf 는 AC-4 따라 텍스트 |
| T-PH002-02 | done | editorMode.ts resolveEditorMode + languages.ts, unit 1583/1583 |
| T-PH002-03 | done | 탐색기 열기/아이콘 판정 출처 테스트 3건 red |
| T-PH002-04 | done | 탐색기 열기/아이콘을 resolveEditorMode 로, unit 1584/1584 |
| T-PH003-01 | done | codeEditorExtensions.test.ts 5건 red |
| T-PH003-02 | done | codeEditorExtensions.ts + CodeFileEditor.tsx (미연결), unit 1589/1589, vite build OK |
| T-PH003-03 | done | editorDocumentPanelMode.test.ts 4건 red |
| T-PH003-04 | done | 문서 패널 코드 모드 분기 연결, unit 1593/1593 |
| T-PH004-01 | done | dataFileLint.test.ts 6건 red |
| T-PH004-02 | done | dataFileLint.ts/csvColumns.ts + @codemirror/lint 직접 의존, unit 1599/1599 |
| T-PH005-01 | done | readImageFile/maxImageFileSize 테스트 5건 red |
| T-PH005-02 | done | readImageFile + maxImageFileSize 전 경로 전달, server tsc OK |
| T-PH005-03 | done | fileRoutes.imageRead.test.ts 5건 red |
| T-PH005-04 | done | GET /:id/files/read-image + img-src blob:, release-pipeline 13/13 |
| T-PH005-05 | done | fileApiImageRead.test.ts 2건 red |
| T-PH005-06 | done | fileApi.readImage → Blob, unit 1601/1601 |
| T-PH006-01 | done | imageViewerModel.test.ts 8건 red |
| T-PH006-02 | done | imageViewerModel.ts + ImageFileViewer.tsx/css (미연결), unit 1609/1609 |
| T-PH006-03 | done | editorImageTab.test.ts 5건 red |
| T-PH006-04 | done | editorDocumentLoad.ts, 이미지 탭 열기/복원/뷰어 연결, unit 1614/1614 |
| T-PH007-01 | done | svgTabModel.test.ts 7건 red |
| T-PH007-02 | done | svgTabModel.ts + SvgFileTab.tsx, unit 1621/1621 |
| T-PH008-01 | done | code-editor-text.spec.ts 9/9 x2, 결함 2건 수정(JSON 오류 줄, 탭 x 닫기 확인), unit 1625/1625 |
| T-PH008-02 | done | code-editor-image.spec.ts 7/7, 제품 결함 없음 |
| T-PH008-03 | done | CLAUDE.md 편집기 설명 갱신 + worklog 1건 |
| T-PH008-04 | done | 회귀 unit 1630/1630, release-pipeline 13/13, E2E 16/16; 리뷰 HIGH 1(삽입 LF 정규화) 수정 |

## 실행 중 발견·수정한 결함
- JSON 구문 오류가 1행에 표시되던 문제 (T-PH008-01)
- 탭 × 가 저장 안 된 문서를 확인 없이 닫던 문제 — 마크다운에도 해당 (T-PH008-01)
- CRLF 파일에 LF 삽입(Enter/붙여넣기/위젯)이 그대로 저장되던 문제 (T-PH008-04 독립 리뷰 HIGH)

## 잔여
- 기존 baseline 실패: config.schema terminalWireFormat 기본값 1건, RuntimeConfigStore terminalWireFormat 2건 (config.schema.ts:53, HEAD 동일)
- maxImageFileSize 는 설정 UI 에 노출되지 않음 (config.json5 로만 변경)
- 핀치 줌은 E2E 미검증 (휠 줌·드래그만)
- 새로고침 후 삭제된 이미지는 탭 없이 조용히 건너뜀
- verified 승급 안 함
