---
title: twoFactor 설정 구조 평탄화
project: BuilderGate
date: 2026-04-09
type: refactor
tech_stack: Node.js + TypeScript, Zod
code_path: server/src
request_doc: docs/archive/srs/request/2026-04-09.request.srs-plan.twoFactor-설정-구조-평탄화.md
---

# twoFactor 설정 구조 평탄화

---

# Part 1: SRS (무엇을)

## 1.1 목적
`config.json5`의 `twoFactor.totp` 중첩 객체를 제거하고 TOTP 필드를 `twoFactor` 직하로 이동하여 설정 구조를 단순화한다.

## 1.2 배경
이메일 2FA 제거로 TOTP가 유일한 2FA 방식이 되었다. `twoFactor.totp.*` 중첩은 더 이상 의미가 없으며, 평탄한 구조가 직관적이다.

## 1.3 기능 요구사항
- FR-1: `config.json5`와 `config.json5.example`의 `twoFactor` 구조를 평탄화한다
  ```json5
  // 변경 전
  twoFactor: { externalOnly: false, totp: { enabled: true, issuer: "BuilderGate", accountName: "admin" } }
  // 변경 후
  twoFactor: { enabled: true, externalOnly: false, issuer: "BuilderGate", accountName: "admin" }
  ```
- FR-2: 서버 타입/스키마(`config.types.ts`, `config.schema.ts`)를 평탄화된 구조에 맞게 수정한다
- FR-3: 설정 서비스(`RuntimeConfigStore`, `SettingsService`, `ConfigFileRepository`)가 평탄화된 키(`twoFactor.enabled`, `twoFactor.issuer`, `twoFactor.accountName`)를 사용하도록 수정한다

## 1.4 비기능 요구사항
- NFR-1: TypeScript 빌드 오류 없음 (서버 + 프론트엔드)
- NFR-2: TOTP 기능 동작 변경 없음 (등록, 검증, 로그인 흐름 유지)
- NFR-3: 기존 테스트(`test-runner.ts`) 통과 유지

## 1.5 제약사항
- `TOTPService` 생성자는 `{ enabled, issuer?, accountName? }` 구조 객체를 받으므로, `config.twoFactor`를 직접 전달 가능 (별도 어댑터 불필요)
- `TwoFactorConfig` 인터페이스에서 `TOTPConfig` 별도 인터페이스는 삭제하고 필드를 직접 병합

## 1.6 현행 코드 분석

### 영향 범위
| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `server/config.json5` | 수정 | `totp` 블록 제거, 3개 필드 평탄화 |
| `server/config.json5.example` | 수정 | 동일 |
| `server/src/schemas/config.schema.ts` | 수정 | `totpSchema` 삭제, `twoFactorSchema`에 3개 필드 직접 추가 |
| `server/src/types/config.types.ts` | 수정 | `TOTPConfig` 인터페이스 삭제, `TwoFactorConfig`에 3개 필드 병합 |
| `server/src/types/settings.types.ts` | 수정 | `EditableSettingsKey`, `TwoFactorEditableSettings`, `SettingsPatchRequest` 평탄화 |
| `server/src/services/RuntimeConfigStore.ts` | 수정 | `totpSchema` import 제거, `FIELD_SCOPES` 키 변경, `mergeEditablePatch`/`buildEditableValues` 수정 |
| `server/src/services/SettingsService.ts` | 수정 | `patchSchema`의 `totp` 중첩 제거, `extractChangedKeys` 3개 분기 수정 |
| `server/src/services/ConfigFileRepository.ts` | 수정 | `setPath` 경로 3-depth→2-depth, `renderPatchedConfig` Map 키 변경 |
| `server/src/services/TOTPService.ts` | 수정 | `import type { TOTPConfig }` → `import type { TwoFactorConfig }`, 생성자 파라미터 타입 변경 |
| `server/src/index.ts` | 수정 | `config.twoFactor?.totp?.enabled` → `config.twoFactor?.enabled`, TOTPService 생성 인자 변경 |
| `server/src/test-runner.ts` | 수정 | 픽스처 구조 평탄화 + `testTwoFactorSchemaTotp` 어서션 변경 (`result.data?.totp?.enabled` → `result.data?.enabled`) |

### 재사용 가능 코드
- `setPath()` 유틸 (`ConfigFileRepository.ts` 내부) — 경로 변경만 필요, 함수 자체 재사용
- `twoFactorSchema.parse({})` — 기본값 파싱 패턴 유지

### 주의사항
- `TOTPService` 생성자가 현재 `TOTPConfig` 타입을 받으므로, `TOTPConfig` 삭제 후 `TwoFactorConfig` 타입을 직접 전달 (또는 인라인 타입으로 대체)
- `config.json5` 파일 내 `totp` 블록이 남아있으면 `renderPatchedConfig` 키 매칭 실패 → config.json5도 반드시 함께 수정

---

# Part 2: 구현 계획 (어떻게)

## Phase 1: 설정 파일 수정
- [ ] Phase 1-1: `server/config.json5`의 `twoFactor` 블록 평탄화 `FR-1`
  ```json5
  twoFactor: {
    enabled: true,             // TOTP 활성화
    externalOnly: false,
    issuer: "BuilderGate",
    accountName: "admin"
  }
  ```
- [ ] Phase 1-2: `server/config.json5.example`의 `twoFactor` 블록 동일하게 수정 `FR-1`
- **재사용:** 없음 (직접 텍스트 편집)
- **테스트:**
  - 정상: 서버 시작 시 config 파싱 성공, `[TOTP] TOTPService initialized` 로그 출력
  - 예외: 기존 `totp` 블록 있는 채로 서버 기동 시 Zod validation error 발생해야 함 (Phase 2 이후)

## Phase 2: 타입/스키마 + settings.types.ts 수정
> **순서 중요**: 타입 변경(Phase 2) → 서비스 코드 변경(Phase 3) 순으로 진행해야 컴파일 오류 없음
- [ ] Phase 2-1: `server/src/schemas/config.schema.ts` — `totpSchema` export 삭제, `twoFactorSchema`에 `enabled`, `issuer`, `accountName` 3개 필드 직접 추가 `FR-2`
  ```typescript
  export const twoFactorSchema = z.object({
    enabled: z.boolean().default(false),
    externalOnly: z.boolean().default(false),
    issuer: z.string().default('BuilderGate'),
    accountName: z.string().default('admin'),
  });
  ```
- [ ] Phase 2-2: `server/src/types/config.types.ts` — `TOTPConfig` 인터페이스 삭제, `TwoFactorConfig`에 3개 필드 병합 `FR-2`
  ```typescript
  export interface TwoFactorConfig {
    enabled: boolean;
    externalOnly: boolean;
    issuer?: string;
    accountName?: string;
  }
  ```
- [ ] Phase 2-3: `server/src/types/settings.types.ts` — `EditableSettingsKey` 키 변경, `TwoFactorEditableSettings` 평탄화, `SettingsPatchRequest` 평탄화 `FR-3`
  ```typescript
  // EditableSettingsKey 변경 (3개)
  | 'twoFactor.enabled'       // 구: 'twoFactor.totp.enabled'
  | 'twoFactor.issuer'        // 구: 'twoFactor.totp.issuer'
  | 'twoFactor.accountName'   // 구: 'twoFactor.totp.accountName'

  // TwoFactorEditableSettings: totp 중첩 필드 제거, 3개 필드 직접 추가
  export interface TwoFactorEditableSettings {
    enabled: boolean;
    externalOnly: boolean;
    issuer: string;
    accountName: string;
  }

  // SettingsPatchRequest: twoFactor.totp 중첩 제거, 3개 필드 직접 추가
  twoFactor?: {
    externalOnly?: boolean;
    enabled?: boolean;     // 추가 (구: totp.enabled)
    issuer?: string;       // 추가 (구: totp.issuer)
    accountName?: string;  // 추가 (구: totp.accountName)
  }
  ```
- **재사용:** 기존 Zod 패턴(`z.boolean().default(false)`) 유지
- **테스트:**
  - 정상: `twoFactorSchema.parse({ enabled: true, externalOnly: false })` 성공, 기본값 채워짐
  - 예외: `twoFactorSchema.parse({ totp: { enabled: true } })` → strict 모드 아니므로 무시됨 (기존 config.json5 마이그레이션 전 안전)

## Phase 3: 설정 서비스 수정
> **순서 중요**: Phase 3-2(SettingsService patchSchema) → Phase 3-1(RuntimeConfigStore) 순으로 수정해야 중간 컴파일 오류 없음. 두 파일은 단일 커밋으로 묶을 것.

- [ ] Phase 3-1: `server/src/services/RuntimeConfigStore.ts` 수정 `FR-3`
  - `totpSchema` import 제거
  - `FIELD_SCOPES` 키 변경: `'twoFactor.totp.enabled'` → `'twoFactor.enabled'` 등
  - `mergeEditablePatch()`: `patch.twoFactor?.totp?.*` → `patch.twoFactor?.enabled` 등
  - `buildEditableValues()`: `totpDefaults` 라인 제거, 평탄화된 필드로 구성
- [ ] Phase 3-2: `server/src/services/SettingsService.ts` 수정 `FR-3`
  - `patchSchema`에서 `totp` 중첩 객체 제거, 3개 필드를 `twoFactor` 레벨로 이동
  - `extractChangedKeys()`: `'twoFactor.totp.enabled'` → `'twoFactor.enabled'` 등 3개 변경
- [ ] Phase 3-3: `server/src/services/ConfigFileRepository.ts` 수정 `FR-3`
  - `applyEditableValues()`: `setPath(rawConfig, ['twoFactor', 'totp', 'enabled'], ...)` → `setPath(rawConfig, ['twoFactor', 'enabled'], ...)`
  - `renderPatchedConfig()`: Map 키 `'twoFactor.totp.enabled'` → `'twoFactor.enabled'` 등 (렌더러는 stack 기반 경로 추적으로 동작하므로 Map 키 변경만으로 충분, 별도 파서 로직 수정 불필요)
- **재사용:** `setPath()` 함수, `renderJson5Value()` 함수 그대로 재사용
- **테스트:**
  - 정상: `buildEditableValues()` 반환값에 `twoFactor.enabled` 존재
  - 예외: `mergeEditablePatch`에 `{ twoFactor: { totp: { enabled: true } } }` 전달 시 무시됨 (구버전 패치 무해 처리)

## Phase 4: index.ts + TOTPService 인자 수정
- [ ] Phase 4-1: `server/src/index.ts` 수정 `FR-2`
  - TOTPService 초기화 조건: `config.twoFactor?.totp?.enabled` → `config.twoFactor?.enabled`
  - TOTPService 생성: `new TOTPService(config.twoFactor.totp, ...)` → `new TOTPService(config.twoFactor, ...)`
  - `twoFAStatus` 람다 내 `config.twoFactor?.totp?.enabled` → `config.twoFactor?.enabled` (약 350~355줄)
  - `[2FA]` 시작 로그의 `config.twoFactor?.totp?.enabled` 참조도 동일하게 변경
- [ ] Phase 4-2: `server/src/services/TOTPService.ts` 타입 참조 수정 `FR-2`
  - `import type { TOTPConfig }` → `import type { TwoFactorConfig }`
  - 생성자 파라미터 타입: `TOTPConfig` → `Pick<TwoFactorConfig, 'enabled' | 'issuer' | 'accountName'>` (또는 `TwoFactorConfig` 직접 사용)
  - TOTPService 내부는 `config.enabled`, `config.issuer`, `config.accountName`만 사용하므로 로직 변경 없음
  - `index.ts`에서: `new TOTPService(config.twoFactor, cryptoService)` (평탄화된 `twoFactor` 객체 직접 전달 — 필요한 3개 필드 모두 포함)
- **재사용:** TOTPService 내부 로직 변경 없음, 타입 참조만 수정
- **테스트:**
  - 정상: 서버 기동 → `[TOTP] TOTPService initialized` 출력
  - 예외: `config.twoFactor.enabled = false` 시 TOTPService 생성 안 됨

## Phase 5: 테스트 코드 업데이트
- [ ] Phase 5-1: `server/src/test-runner.ts` 픽스처 수정 `NFR-3`
  - `createConfigFixture()`: `totp` 블록 제거, `enabled/issuer/accountName` 평탄화
  - `createConfigFixtureContent()`: JSON5 문자열 내 `totp` 블록 제거
  - `testTwoFactorSchemaTotp()`:
    ```typescript
    // before
    twoFactorSchema.safeParse({ externalOnly: false, totp: { enabled: true } })
    assert.equal(result.data?.totp?.enabled, true)
    // after
    twoFactorSchema.safeParse({ externalOnly: false, enabled: true })
    assert.equal(result.data?.enabled, true)
    ```
  - `testTwoFactorSchemaDisabled()`: `externalOnly`만 검증하므로 변경 불필요
  - `createConfigFixture()`: 기존에 `totp` 블록 없는 경우 무수정, 있으면 평탄화
  - `renderConfig()` 내 백틱 JSON5 픽스처 문자열 (약 553~565줄): `totp: { ... }` 블록 제거 후 `enabled`, `issuer`, `accountName` 3개 필드를 `twoFactor` 레벨로 이동
  - `makeAuthHarness()`: TOTPService 생성 인자를 `{ enabled: true, issuer: 'Test', accountName: 'test' }` 평탄화된 객체로 변경
- [ ] Phase 5-2: 기존 테스트 함수 추가 수정 `NFR-3`
  - `testSettingsServicePersistence()` 내 PATCH 바디: `{ twoFactor: { totp: { enabled: true } } }` → `{ twoFactor: { enabled: true } }` 로 변경
  - `testRuntimeConfigCapabilities()` 내 FIELD_SCOPES 키 참조 (`'twoFactor.totp.enabled'` 등) 평탄화 형식으로 변경
  - `testSettingsGetTwoFactor()` 추가 (파일: `test-runner.ts`, 위치: `testSettingsServicePersistence` 이후):
    - `buildEditableValues()` 반환값에서 `twoFactor.totp` 키 없음 확인
    - `assert.equal(values.twoFactor.enabled, false)` (기본값)
    - `assert.equal(values.twoFactor.issuer, 'BuilderGate')`
    - `assert.equal(values.twoFactor.accountName, 'admin')`
- **재사용:** 기존 테스트 패턴 유지
- **테스트:**
  - 정상: `twoFactorSchema.safeParse({ enabled: true, externalOnly: false })` → `result.data.enabled === true`
  - 정상: `buildEditableValues()` 반환 `values.twoFactor` 에 `enabled`, `issuer`, `accountName` 직접 포함

## 단위 테스트 계획

### 테스트 대상
| 대상 | 테스트 유형 | 시나리오 |
|------|------------|----------|
| `twoFactorSchema` | 단위 | 정상: `{ enabled: true }` 파싱 성공 / 예외: 구버전 `{ totp: {...} }` 입력 시 무시 |
| `buildEditableValues()` | 단위 | 정상: 반환값에 `twoFactor.enabled` 포함 |
| TOTPService 생성 | 통합 | 정상: `config.twoFactor` 직접 전달 시 초기화 성공 |

### 기존 테스트 영향
- 기존 테스트 파일: `server/src/test-runner.ts`
- 회귀 위험: 있음 (픽스처 구조 변경 필요)
- 추가 필요 테스트: 0개 (기존 픽스처 수정으로 충분)

## 검증 기준
- [ ] 빌드 성공: `cd server && npx tsc --noEmit` 오류 없음
- [ ] 서버 기동: `node dev.js` 후 `[TOTP] TOTPService initialized` 출력
- [ ] 기존 테스트 통과: `test-runner.ts` 전체 통과
- [ ] GET `/api/settings` 응답에서 `twoFactor.totp` 키 부재 확인 (평탄화된 `twoFactor.enabled` 존재)
- [ ] PATCH `/api/settings` `{ twoFactor: { enabled: true } }` 정상 처리 확인
- [ ] `server/config.json5` 파일에 `totp` 블록 없음 확인
- [ ] 요구사항 매핑: FR-1 → Phase 1, FR-2 → Phase 2+4, FR-3 → Phase 3

## 후속 파이프라인
- 다음 단계: `snoworca-plan-driven-coder`
- 입력 인자:
  - PLAN_PATH: `docs/archive/srs/step6.srs-plan.twoFactor-설정-구조-평탄화.2026-04-09.md`
  - LANGUAGE: TypeScript (Node.js 18+)
  - FRAMEWORK: Express + Zod
  - CODE_PATH: `server/src`
