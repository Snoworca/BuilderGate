# Integration Test Guide

## Automated

- Desktop Chrome Playwright target: `https://localhost:2002`
- source rect before/after drag start
- drag preview presence during drag start
- split guide/root drag container presence in non-equal drag
- split invalid-drop no-shrink
- reorder invalid-drop no-shrink
- right-click / non-primary / handle-only regression

## Manual

- drag 시작 순간 source pane이 접히지 않는지 확인
- source와 preview가 동시에 보여도 UX가 허용 가능한지 확인
- none mode에서도 split guide가 계속 보이는지 확인
- split mode에서도 시각 흔들림이 줄었는지 확인
