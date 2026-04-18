# Integration Test Guide

## 대상

- OS별 최초 `config.json5` bootstrap
- non-Windows stale PTY config load normalization
- Settings capability/UI/save 계약 정렬

## 공통 환경

- 검증 URL: `https://localhost:2002`
- 로컬 테스트 비밀번호: `1234`
- 저장소 루트: `C:\Work\git\_Snoworca\ProjectMaster`

## 서버 회귀 테스트

### 1. server test-runner

```powershell
cd server
npm run test
```

확인 포인트:

- missing config bootstrap fixture
- stale Windows PTY config on non-Windows fixture
- Settings capability / validation alignment

## 프런트 검증

### 2. frontend build

```powershell
cd frontend
npm run build
```

확인 포인트:

- Settings 페이지 타입/렌더링 회귀 없음

## 수동 검증 매트릭스

### Case A: macOS/Linux clean install

1. `server/config.json5`를 제거한다
2. 서버를 시작한다
3. 기대 결과:
   - `config.json5`가 자동 생성된다
   - 서버가 부팅 실패하지 않는다
   - Settings에서 Windows 전용 PTY 필드가 보이지 않는다

### Case B: macOS/Linux stale Windows config

1. `useConpty: true`, `windowsPowerShellBackend: "conpty"`가 들어 있는 config를 준비한다
2. 서버를 시작한다
3. 기대 결과:
   - startup hard-fail이 발생하지 않는다
   - 새 세션 생성도 안전한 shell/backend 정책으로 동작한다

### Case C: Windows clean install

1. `server/config.json5`를 제거한다
2. 서버를 시작한다
3. 기대 결과:
   - `config.json5`가 자동 생성된다
   - Windows용 ConPTY 선호 기본값이 반영된다
   - 기존 Windows startup 흐름이 유지된다

### Case D: non-Windows Settings save

1. Settings 페이지 진입
2. PTY와 무관한 설정 하나를 수정
3. 저장
4. 기대 결과:
   - Windows 전용 PTY 필드가 보이지 않는다
   - save가 hidden PTY 값 때문에 실패하지 않는다

### Case E: Windows Settings capability

1. Windows 호스트에서 Settings 진입
2. winpty probe 결과에 따라 PTY backend options 확인
3. 기대 결과:
   - UI에 노출된 옵션과 save validation이 서로 모순되지 않는다

## 실패 시 점검 순서

1. `server/src/utils/config.ts` bootstrap/normalization 경로 확인
2. `server/src/services/SessionManager.ts` runtime assertion 경로 확인
3. `server/src/services/RuntimeConfigStore.ts` capability snapshot 확인
4. `server/src/services/SettingsService.ts` validation 경로 확인
5. `frontend/src/components/Settings/SettingsPage.tsx` conditional render / save recovery 경로 확인
