# Integration Test Guide

## Automated

- Playwright target: `https://localhost:2002`
- 핵심 시나리오:
  - `1 -> 5`
  - `5 -> 1`
  - middle-to-middle
  - self-drop no-op
  - non-primary button no-op
  - equal reorder persistence
  - non-equal mode non-entry
  - right-click context menu no-regression

## Manual

- hovered cell 전체가 blue guide로 덮이는지 확인
- split guide 잔상이 사라졌는지 확인
- source ghost/opacity가 자연스러운지 확인
- none/focus/auto에서 reorder가 시작되지 않는지 확인
