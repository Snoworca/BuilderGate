# Wave 1 additive characterization requirement input

Target `wave-1`에 GitHub #3/#23을 위한 additive envelope Requirement만 작성한다.

1. Split runtime/test/SRS drift를 characterization하고 restore 또는 supersede를 미리 선택하지 않는다.
2. Refresh retained-state 절단과 현재 legacy 경계를 deterministic하게 재현한다. 24/1,000/10,000행과 legacy 2MiB는 test corpus이며 제품 목표가 아니다.
3. Local cache valid/absent/poisoned, active/hidden, Unicode/alternate-buffer를 구분한다.
4. `NO_RENDER`, `NO_ANALYZER`, `NO_NETWORK`, `ONE_CLIENT_SLOW`와 raw evidence schema를 계약한다.
5. G1 decision record가 `confirmed-bug-only` 또는 `architectural migration`을 증거로 선택하게 한다.
6. Product retained rows, aggregate memory, checkpoint chunk/in-flight budget은 이 subcycle에서 결정하지 않는다.
7. 기존 `0.5.5-buildergate-stability` Requirement를 수정·이동·복제·supersede하지 않는다.
8. Authority promotion, UI 시각 변경, legacy 삭제는 수행하지 않는다.

G1이 `confirmed-bug-only`이면 재현된 결함 중 하나를 wave-1 local-fix issue로 선택해 회귀 evidence와 함께 종결할 수 있다. `architectural migration`이면 후속 stable retained-state authority 계약을 먼저 만든 뒤 wave-2~wave-5를 활성화한다.
