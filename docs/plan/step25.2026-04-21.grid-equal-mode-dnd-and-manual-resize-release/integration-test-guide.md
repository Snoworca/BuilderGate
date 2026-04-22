# Integration Test Guide

## Manual Scenarios

### Scenario A: Equal mode tile drop

1. grid mode에서 equal 선택
2. 타일 하나를 다른 위치에 드래그해 drop
3. drop 직후 2행 고정 격자 배치가 다시 적용되는지 확인
4. 세션이 5개면 위 3개 / 아래 2개인지 확인

### Scenario B: Equal mode split resize

1. grid mode에서 equal 선택
2. split handle을 직접 드래그
3. equal 표시가 해제되어 mode 없음이 되고 사용자 비율이 유지되는지 확인

### Scenario C: Portrait equal arrangement

1. viewport를 세로가 더 길게 만든다
2. equal 선택
3. 2열 고정으로 계산되는지 확인
4. 이후 viewport 비율을 바꿔도 arrangement가 자동으로 뒤집히지 않는지 확인

### Scenario D: Toolbar toggle off

1. equal 또는 focus 또는 auto 중 하나 선택
2. 같은 버튼을 다시 클릭
3. mode 없음으로 해제되는지 확인
4. 현재 tree는 그대로 유지되는지 확인

### Scenario E: Focus/Auto regression

1. focus mode 선택 후 타일 포커스 이동
2. auto mode 선택 후 상태 변화
3. 기존 동작이 유지되는지 확인
