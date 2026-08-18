# 바이너리 데이터 플레인 — 작업 계획

| 항목 | 값 |
|---|---|
| 작성일 | 2026-08-16 |
| 개정일 | 2026-08-18 (독립 검증 **6차** 반영 — HIGH 3 · MEDIUM 2 · LOW 4. 인용 `file:line` 을 전부 직접 열어 재확인. **전건 반영, 기각 0건 · 수치 정밀화 1건**(§14.0). 라벨 규약은 §14.0·§14.1·§14.2 주의 참조. 선행 5차 기록은 §14.1) |
| 상위 결정 | [`00-decision-record.md`](./00-decision-record.md) — 무조건 도입, 측정 게이트 폐기 |
| 근거 연구 | [`01`](./01-frame-format-and-negotiation.md) 프레임·협상 / [`02`](./02-server-integration-sites.md) 서버 / [`03`](./03-client-decode-path.md) 클라이언트 / [`04`](./04-srs-amendment-plan.md) SRS / [`05`](./05-test-migration-rollback.md) 테스트·롤백 |
| 대상 target | `wave-5` (현재 Active Target 은 `wave-3` — **`docs/spec/00.index.md:9`** `\| Active Target \| wave-3 \|`. `:35` 는 Target Map 의 wave-3 **행**이지 Active Target 필드가 아니다. 전환은 S0 소관) |
| 현재 상태 | 착수 전. **S-1 부터** 시작한다 |

**이 문서의 지위**: 실행 순서와 결정의 SSOT 다. **사양의 사본이 아니다.** 프레임 바이트 레이아웃·협상 메시지 스키마·디코더 의사코드는 `01` 이 정본이고, 서버 개입 지점은 `02`, 클라이언트는 `03`, SRS 조문은 `04`, 테스트·롤백은 `05` 가 정본이다. 여기서는 **어떤 순서로, 무엇을 게이트로, 어떤 커맨드로 확인하며** 진행하는지만 정한다.

라벨 규약: `[설계결정]` 이 문서의 판단 · `[미확인]` 코드로 확인 못 함 · `[추정]` 근거 있는 추정 · `[추측]` 코드에서 읽히나 재현 못 함.

---

## 0. 개정 요약 — 이번 판에서 바뀐 것

| # | 이전 판 | 이번 판 |
|---|---|---|
| 1 | 핀 파일 2개 | **핀 5계열** (§2). 06 이 편집하는 파일 중 5개 게이트가 물려 있다 |
| 2 | S0.5 리허설 = "임시 디렉터리로 발행 후 대조" | **4단계 리허설** (no-op 편집 → red 확인 → republish → green 복구). 임시 디렉터리 호출은 `05:297` 이 지적하듯 **이미 되는 것**이라 리허설이 아니다 |
| 3 | 검증 커맨드 0건 | 모든 단계에 **파일 위치 · 소속 스위트 · 커맨드(cwd 포함)** |
| 4 | S2 왕복 테스트 | 왕복만으로는 vacuous — **골든 벡터 파일** + differential 필수 (§4 S2) |
| 5 | 선행 3건 누락 | `FR-BGSTAB-017` · `REL-BGSTAB-007` AC-4 · `channelId` 생명주기를 단계로 편입 (§4 S0.7 / S2.5, §9) |
| 6 | 설정 키 = 2값 enum | **4값 사다리**로 재검토 (§3.1). 사다리가 곧 마이그레이션 단계다 |
| 7 | 롤백 드릴 4항목 | R1~R7 전건 + **R7 경계 대조군** (§4 S6) |
| 8 | "봉투 250~400B → 28B" | 산수 정정 (§10). 250–400 은 `02:268` 의 `[추정]`, 프롤로그 포함 시 **52B** |
| 9 | 커밋 순서 전제 | **정정 명시** (§2.1) — provenance 는 git 을 호출하지 않는다. **단 범위는 fair-scheduler provenance/evidence-bundle 쌍에 한정**(2차 검증 H-4) |
| **10** | `05` 를 조건 없이 "정본" 으로 인용 | **`05` 전체가 21B 초안 기반**임을 §2.3 에 명시하고, F1~F8·P2 를 28B 로 재작성 (§4 S2-b). **2차 검증 CRITICAL** |
| **11** | S5 재조정 임계값 "5개" | `wsSendPolicy.ts:518-528` 은 **9필드 인터페이스**이고 `resolveFairTerminalDeliveryPolicy` 는 `TerminalResourcePolicy.ts:26` 에 있다 (§5 S5-a). **2차 검증 HIGH** |
| **12** | silent drop 7/8 혼재 | 집합을 **8항목으로 확정**하고 `05` 정본(7)과의 차이를 명시 (§5 S3, §9, §13) |
| **13** | 인용 오차 20여 건 | `file:line` 전건 재확인 후 정정. **기각한 finding 1건은 §14 에 근거와 함께 기록** |
| **14** | (3차 검증) `visibilityWeight`/`driverWeight` 가 "같이 움직인다" | **거짓.** 둘은 **8 / 16 고정 비율**이다. S5 는 *"바이트 5개 재측정 + 비율·문자열 4개 재귀속"* 으로 재정의 (§5 S5-a). ⚠️ **단 무조건 항등식이 아니다 — 아래 20행이 조건을 정정한다.** 그리고 **셈법은 5차에서 `5 + 3 + 1` 로 다시 정정되었다**(아래 32행) |
| **15** | (3차 검증) S5-a 검증 커맨드가 "키 집합을 단정한다" | **거짓.** 6개 키만 단정하며 **AC-4 의 3개가 무방비**. §7 항목 9 로 등재하고 S5 선행 보강 지시 |
| **16** | (3차 검증) F9 대조군이 없는 rejection code 를 요구 · P7 이 28B 에서 성립 불가 | F9 는 `bad-frame-version` 단일 수렴으로 확정, P7 은 "빈 **본문**" 으로 재작성 (§4 S2-b) |
| **17** | (3차 검증-B **HIGH**) D1 의 본문-only `encodedBytes` 가 `01:728`·`02:243`·`00:78` 세 정본과 정면 충돌하는데 **그 사실이 문서 어디에도 없었다** | **§3.1-A 신설 — 세 정본을 명시 기각하고 사유·파급·`00:78` 과의 양립 조건을 기록.** 기각 없이는 S0 착수 불가 (하드 게이트) |
| **18** | (3차 검증-B) §4.2 `byteLength` 식이 **프레임 1개용**인데 계획서는 배칭(1 WS 메시지 = N 프레임)을 채택 | **배치 식 명시** — `byteLength = Σ(프레임)`. 정본은 `01:1429` `byteLength: out.length` (§4.2) |
| **19** | (3차 검증-B) 핀 상세표 P1·P2·P4 의 "건드리는 단계" 가 §1.5 매트릭스·단계별 "핀 영향" 행과 어긋남 | **매트릭스에 맞춰 정정** (§1.5). P1 에 **S2.5·S3** 누락은 `WsRouter.ts` 편집 후 republish 를 건너뛰게 만든다 |
| **20** | (3차 검증-B) F5 2 MiB 상한의 **도메인 미지정** · `visibilityWeight≡8`/`driverWeight≡16` 을 **무조건**으로 서술 | F5 는 **본문(body) 도메인**으로 확정(§4 S2-b), 불변식은 **조건부**(`controlLimit ≥ 64` / `outputLimit ≥ 16`)로 정정하고 스키마 하한이 그 조건을 보증함을 명시 (§5 S5-a) |
| **21** | (3차 검증-B LOW ×8) 21B 잔재 인용 2건 · 누락 테스트 1건 · 인용 오차 3건 · 조건 반전 1건 · 단계 배정 공백 1건 | 전건 반영. 상세는 §14 |
| **22** | (4차 **HIGH H-1**) 본문-only `encodedBytes` 결정이 **JSON codec 측을 한 번도 규정하지 않았다** — 그 공백이 `01:728` 기각의 유일한 근거(`05:204` 인코딩 불변)를 무너뜨리고 §5 S5-a 말미와 정면 모순 | **§3.1-B 신설 — `encodedBytes` 는 두 codec 모두 본문-only 이며 JSON 측 전환 시점을 S5 로 확정.** 프롤로그-only 0B 크레딧 귀결도 처분(`max(bodyBytes,1)` floor + 프레임 수 상한은 `byteLength` 도메인 소관). AC 문면 지시 갱신. ⚠️ **괄호 안 후반부는 이후 두 번 정정되었다** — 5차 L-6(배타적 소관 부정) · **6차 H-3**(우열 서술도 반증 가능). 현행 정본은 *"두 도메인이 각각 상한을 준다"* 하나다 |
| **23** | (4차 **HIGH H-2**) §7 항목 1 의 리터럴 처방(12 / 9)이 **현행 `encodedBytes` 의미(JSON 봉투 전체)와 어긋나 S1 을 즉시 red** 로 만든다 | **도메인에 맞는 리터럴로 처방 교체** — S1 은 **봉투 기대값**(131 / 128), 본문-only 리터럴(12 / 9)은 **S5 도메인 전환 시점**의 값. §7 항목 1 주 전면 개정. ⚠️ **5차 L-2 보강**: S1 의 산출물은 맨 숫자 리터럴이 아니라 **손으로 적은 봉투 문자열 + `Buffer.byteLength`** 이며 131/128 은 주석에만 나온다 |
| **24** | (4차 M-1) §3.1-A 의 `00:78` 양립 논증이 "단일 domain" 을 **두 뜻으로** 사용 | **뜻을 "서버 원장 ↔ 클라이언트 ACK 보고의 일치" 하나로 고정**하고, 와이어 도메인과의 분리는 `00:78` 소관이 아님을 명시 (§3.1-A) |
| **25** | (4차 M-2) P3 git-status 게이트가 `--expect-red` 전용인데 **세 곳이 무조건으로 서술**하고 그 전제로 D6 마감을 도출 | §2.1 범위 한정 표·목록, §1.5 P3 상세, §3 D6 주의, §3.2 D6 행, §13 층 B 를 **전부 `--expect-red` 한정으로 정정**하고 D6 실제 마감을 재도출 |
| **26** | (4차 M-3) S0-c 의 AC 저작 지시 *"S5 재조정 대상 = 정책 키 9개"* 가 §5 S5-a 확정 결론(5 재측정 + 4 재귀속)과 어긋남 — AC 사후 편집 불가 | **S0-c 행을 "바이트 5개 재측정 + 비율/문자열 4개 재귀속" 으로 교체.** `PERF-BGSTAB-010` AC-4 의 7개와의 관계도 함께 명시. ⚠️ **5차 M-2 가 이 셈법을 다시 고쳤다 — 현행 정본은 `5 + 3 + 1`**(아래 32행). `ackTimeoutMs` 는 비율도 문자열도 아니다 |
| **27** | (4차 LOW ×6) 40B 예시의 JSON 피연산자 불일치 · 불필요한 `[추정]` · 인용 오차 2건 · Σ 층위 오류 1건 · 체크리스트 순서 1건 | 전건 반영. 상세는 §14.2 |
| **28** | (5차 **HIGH H-1**) §5 S5-a 9키 표가 바이트 임계 4개를 여전히 **와이어 도메인**으로 귀속 — 같은 절 말미의 귀속표(*"인코딩 전환 0×"*)와 정면 모순 | **코드가 정본**: `wsSendPolicy.ts:701`·`:702-703`·`:716-717`·`:738`·`:758` 이 전부 `delivery.encodedBytes` 와 비교. 열 이름을 **"무엇이 값을 움직이는가"** 로 바꾸고 #2·#4·#7·#9 를 **S5-a0 도메인 전환**에 재귀속(인코딩 전환 0×). **#3 `bulkSliceBytes` 는 두 역할이 서로 다른 도메인**이므로 분리 |
| **29** | (5차 H-1) §5 S5-a #4 주의 *"JSON 356 > 128 vs 바이너리 92 < 128, 여유 92/128 ≈ 72%"* 가 **실행 불가능** — 피연산자가 와이어 프레임 크기가 아니다 | 40 B 청크 하나를 시점별로 추적하는 표로 교체 — **오늘 ≈356 → S5-a0 직후 40 → binary-optin 이후 40**. **원인은 도메인 전환, 시점은 아직 JSON, 바이너리 영향 0×, 여유 폭 40/128 = 31.25%.** 결론(*"판정이 뒤집힌다"*, *"기본값에서는 관측 안 됨"*)은 유지 |
| **30** | (5차 H-1) S5-a0 의 관측 동작 변화가 `creditWindowBytes` 확대 하나만 등재됨 | **변화 ② 신설** — 본문 바이트가 `smallOutputBypassBytes` 를 상시 통과해 soft gate·deficit 회계를 우회한다. **전용 실패 테스트 + 129 B 경계 대조군**을 §5 S5-a0 에 등재 |
| **31** | (5차 M-1) `max(bodyBytes,1)` floor 의 사유가 코드로 반증 — 그런데 **사후 편집 불가한 AC** 로 들어간다 | `:836-838` 이 **오늘 이미 `deliverySeq` 에만 의존**하고 AC-6(`30.*:3678`)도 바이트 구분을 요구하지 않는다. **사유를 "원장의 순증" 에서 "예산" 으로 재작성** (floor 1 이 `:701`/`:758` 로 delivery 수를 묶는다) |
| **32** | (5차 M-2) `ackTimeoutMs` 처분이 §5 S0-c·§5 S5-a #8·§13 세 곳에서 다름 | **`5 + 3 + 1` 로 통일** — 바이트 5개 재측정 / 비율·문자열 3개 재귀속 / 시간 1개 별도. `ackTimeoutMs` 는 비율도 문자열도 아니다 |
| **33** | (5차 M-3) §4.2 의 `creditedBytes(ACK)` 를 **누적 총액**으로 정의 — 실제는 **직전 ACK 이후 델타** | `:839-840`(델타) 과 `:843` `lane.creditBytes`(누적)를 분리해 재정의. **테스트가 `lastAcknowledgedSeq=0` 이라 못 잡는다**는 사실과 두 번째 ACK 추가 지시를 함께 등재 |
| **34** | (5차 LOW ×6) `:479` 누락 · S1 산출물을 "리터럴" 로 오칭 · 131 분해 서술 오류 · P2 파일 열거 2건 누락 · codec 무관 조항의 프레임 용어 · floor 후 미갱신 표 1행 | 전건 반영. 상세는 §14.1 |
| **35** | (6차 **HIGH H-1**) §5 S5-a0 "실패 테스트 (② 전용)" 이 **지정 구성에서 충족 불가능** — *"저한도 구성에서 `socketQueuedBytes ≥ socketSoftGateBytes` 인 상태"* 는 `:701` 때문에 도달 불가 | **지시의 두 반쪽이 배타적이었다**: 그 구성의 `socketSoftGateBytes`(12,288) ≥ `creditWindowBytes`(4,096) 이라 soft gate 가지가 사문이고, **스키마 기본값(8,388,608 ≥ 2,097,152)에서도 사문**이다. **변화 ②의 범위를 축소**(soft gate 제외, `:716-717` 도 판별력 없음, 실재하는 것은 `:738-739`)하고, **실패 테스트를 주입 하네스(`FairTerminalDeliveryScheduler.test.ts:132`/`:147`) 기반으로 재작성** |
| **36** | (6차 **HIGH H-2**) §10.1 에 와이어 도메인 추론 잔존 — *"`smallOutputBypassBytes` 판정이 뒤집히는 정도가 28 이냐 52 이냐"* | **폐기.** `:703`/`:716` 의 피연산자는 `delivery.encodedBytes` 라 프레임 고정비가 들어가지 않는다. 28/52 는 `byteLength` 도메인(§10.3 절감률 · `:6098-6099` 게이트 · `01:1401` 배치 상한) 전용임을 명시 |
| **37** | (6차 **HIGH H-3**) AC 문면 지시 3 이 **반증 가능한 명제**를 굳힘 — *"실효 상한은 `byteLength` 쪽이 준다"* | **두 예산이 서로 다른 설정 키**이고 `superRefine`(`config.schema.ts:127-135`)이 관계를 제약하지 않는다 → `perClientOutputQueueMaxBytes=1024` · `serverBufferedHardLimitBytes=536870912` 인 합법 구성이 **반증 사례**. AC 문면을 **"두 도메인이 각각 상한을 준다"** 로 교체하고 우열은 노트로 분리. §14.1 L-6 이 경계한 것과 같은 오류가 정정 문면에 남아 있었다 |
| **38** | (6차 M-1) §5 S5-a 말미가 5차 L-6 정정 이전 문면 유지 | *"프레임 수 상한이 `byteLength` 도메인 소관"* → **"두 도메인이 각각"** 으로 교체. §14.1 L-6 반영 위치 목록에 §5 S5-a 를 등재 |
| **39** | (6차 M-2) 129 B 경계 대조군이 인용한 기전(`:717`)이 129 B 에서 발동 안 함 | `:800` 이 `canSpendDeficit()` 전에 quantum(2,048 / 4,096)을 적립하므로 `:717` 은 항상 참 = **vacuous 대조군**. 기전을 **`:703`**(주입 하네스) 또는 **`:738-739`** 로 교체 |
| **40** | (6차 LOW ×4) §1.5 P1 파일 열거 1건 누락(`:8`) · S5-a0 경계 대조군의 "52" · AC 문면 예시가 ledger 실제 범위보다 좁음 · `:836-838` 표기 | 전건 반영. 상세는 §14.0 |
| **41** | (7차 **HIGH H-1**) §3.1-B 지시 3 의 AC 문면 후보가 **②를 `serverBufferedHardLimitBytes` 백프레셔 게이트로 이름 지목** — 그 게이트가 **`wsSendMode` 종속**이라 스키마 기본값 `'direct'` 에서는 평가조차 되지 않는다 | **AC 문면을 도메인 수준으로 교체**(*"`encodedBytes` 회계 도메인과 와이어 `byteLength` 도메인이 각각 준다"*) + **설정 키 이름 박기 금지.** `wsSendMode` 종속은 노트(S0 지시 5)로 분리. line 427 의 *"기본 배포에서는 ②가 실효 상한 — ≈645,277 프레임"* **폐기**(게이트 미도달). direct 모드의 `byteLength` 상한은 `WsRouter.ts:6169`·`:6182`(`:6158` → `:5761-5763` `perClientOutputQueueMaxBytes`)이며 **적재량 상한이지 총 프레임 수 상한이 아니다** |
| **42** | (7차 MEDIUM M-1 · LOW ×4) 129 B 대조군의 대체 관측(round-delay)이 **단일 lane 에서 vacuous** · `createPolicy` 인자 타입 · 처치군 한 칸 어긋남 · quantum 384 · `:801` 인용 | M-1 = `:812-814` 가 같은 `drain()` 안에서 quantum 을 재적립해 재시도하므로 라운드 수·`sentCount`·latency 어느 것도 갈리지 않는다 → **경쟁 lane + `sent` 순서(round-robin 스킵) 단정으로 교체.** LOW 4건 전건 반영(`{value, source}` · 3번째 delivery · quantum **256** · `:800`). 상세는 §14.0-A |

---

## 1. 연구가 바꾼 것 — 착수 전에 알아야 할 다섯 가지

### 1.1 `#3`(split drift 종결)은 **unified 바이너리의** 선행이 아니다

`01` §5.4 가 확인한 사실: **split 은 프로덕션에서 도달 불가능하다.**

- `server/src/index.ts:1523-1527` 이 `realtime` 설정을 WsRouter 에 **아예 넘기지 않는다** → `WsRouter.ts:606` 이 항상 `unified`
- 프론트는 쿼리 파라미터를 `mode=` 로 보내고(`frontend/src/utils/webSocketUrl.ts:58` control, `:80` output) 서버는 `wsTransportMode=` 를 읽는다(`server/src/ws/WsRouter.ts:1542`) — **이름이 어긋나 있다** (직접 확인)

따라서 바이너리는 **`unified` 위에서 먼저 출시**한다.

⚠️ **다만 "`#3 → #19` 무효" 는 과장이다.** `01:1191` 이 실제로 말한 것은 선행 목록이 **두 묶음으로 분리**된다는 것이다 — **`01:1180-1189`**(표 본문 10행. `:1178` 은 헤더, `:1179` 는 구분선) 의 #1~#6 은 unified 바이너리 선행, **#7(`#3` split drift 종결) · #8(identity 검증) · #9(`WsRouter.ts:5843` mode 검사) 는 split 바이너리 선행으로 그대로 남는다**(`01:1186`~`:1188`). `#3` 은 폐기되지 않고 **split 단계로 이동**한다.

`[미확인]` — **`01:1189`** 의 **#10 `FR-BGSTAB-017`** 은 `01:1191` 의 "1~6 / 7~9" 분류 어디에도 배정되지 않았다. `00:93` 은 "recovery write gate 가 binary 보다 먼저" 라고만 한다. 이 계획은 이를 **unified 선행으로 취급**한다(§4 S0.7) — 근거는 S4/S5 가 snapshot/repair write 경로를 건드리기 때문이다. 배정 확정은 D11(§3.3).

### 1.2 초안 프레임은 세 군데가 틀렸다 → 28B 확정 (정본: `01` §1.1)

| 초안 | 문제 | 확정 |
|---|---|---|
| `streamEpoch 4B` | `Ordinal64 = string` 별칭은 `server/src/types/ws-protocol.ts:16`, `streamEpoch: Ordinal64` 선언은 `:22`. 실체는 **uint64** — `ORDINAL64_MAX` `:961`, canonical 패턴 `:962`, `isCanonicalOrdinal64` `:969`. `advanceRetainedTerminalOrdinal` 은 **`:1000-1002` 에서 소진 시 throw**, **정상 증가는 `:994` `sourceSeq: String(sourceSeq + 1n)`**, `:1005` 는 그 다음 — `streamEpoch: String(streamEpoch + 1n)` + `sourceSeq: '0'` 즉 **소진 후 롤오버**다 (직접 확인) | **8B** |
| 버전 필드 없음 | 버전 불일치와 데이터 손상을 구분할 수 없다 → "명시적 거부" 구현 불가 | `frameVersion 1B` **신설** |
| 확장 여지 없음 | 플래그 하나마다 버전 범프 → 전면 재협상 + fresh snapshot | `flags 2B` + 협상된 `activeFlagMask` |

**확정 헤더 (28 B, big-endian):** 필드명·오프셋은 `01:43-52` 가 정본이다. 06 은 이름만 참조한다.

```
0  frameVersion(1)  1 opcode(1)  2 flags(2)  4 channelId(4)
8  streamEpoch(8)  16 sourceSeq(8)  24 payloadLength(4)  28 payload
```

⚠️ **필드명은 `length` 가 아니라 `payloadLength` 다** (`01:51`, `01:1222`). 이전 판의 `length` 표기는 오기였다.

⚠️ **`flags 2B` 는 의미가 비어 있지 않다.** `01:75-93` 이 규정한다: `END_OF_BATCH`(bit0) 와 `PROLOGUE_PRESENT`(bit3) 는 **협상 불가 필수**이며 `MANDATORY_FLAGS = 0x0009`, v1 `activeFlagMask = 0x000B`. 클라이언트 `acceptedFlagMask` 가 `MANDATORY_FLAGS` 를 빼면 서버는 `mandatory-flag-not-accepted` 로 **협상을 실패시킨다**(`01:93`). **06 만 보고 짠 인코더는 `01` 디코더가 무조건 거부한다** — 플래그 시맨틱은 §4 S2 에서 `01` 을 직접 읽고 구현한다.

### 1.3 헤더에 애플리케이션 식별자를 넣으면 안 된다

현재 `output` 이 나르는 것은 `screenSeq` / `authorityEpoch` / `chunkId` 이지 `streamEpoch`/`sourceSeq` 가 **아니다**(`01:299-306`). `authorityEpoch` 가 **UUID v4 라는 사실**은 `01:302`(`SessionManager.ts:1252` `uuidv4()`), **"UUID(16바이트)라 8바이트 필드에 안 들어간다" 는 논거는 `01:310`** 이다 (2차 검증 L-7).

후자는 retained/checkpoint 평면 소속인데 그 평면이 **아직 꺼져 있다** — `WsRouter.ts:2396-2399` 가 모든 checkpoint ACK 를 `checkpoint-not-active` 로 거절한다(`01:308`). 헤더를 retained 값에 직결하면 승격이 세션 capability 게이트에 걸려 **무기한 연기**된다(`01:318`).

⚠️ **필드 이름 정정** (2차 검증 M-2, 직접 확인): `WsRouter.ts:874-876` 이 만드는 필드는 **`allAttachedViewsCapable`** 이다. **`allRespondersCapable` 은 `WsRouter.ts` 에 0회** 등장하며, `TerminalAuthorityProductionAdapter.ts:2228` 의 `allRespondersCapable: sessionContext?.allAttachedViewsCapable === true,` **한 줄이 두 이름을 잇는 유일한 다리**다. 같은 개념에 이름이 둘이므로 grep 으로 추적할 때 **반드시 두 이름을 모두** 친다.

→ **2계층 식별 모델 채택**: 전송 서수는 헤더에, 애플리케이션 식별자는 **opcode 별 프롤로그**에(`01` §1.8).

### 1.4 진짜 난관은 payload 타입이 아니라 payload 를 되읽는 곳

`JSON.parse(message.payload)` 로 **라우팅 결정**을 내리는 지점 — **직접 전수 확인한 결과 5곳**이다.

| 위치 | 용도 | 바이너리에서의 실패 방향 |
|---|---|---|
| `wsSendPolicy.ts:288` `hasFairDeliveryIdentity` | coalesce 차단 판정 | **`true`**(`:293`) → 모든 output coalesce 차단 |
| `WsRouter.ts:5535` | checkpoint 큐 폐기 | `false` → 큐 정리 안 됨 |
| `WsRouter.ts:5564` | epoch 큐 폐기 | `false` → 큐 정리 안 됨 |
| `WsRouter.ts:6396` | fair-delivery 판별 | `false` → `safe-send-enforce` 강제 종료 위험 |
| **`WsRouter.ts:5846`** | dataGap 재구성 (§8 H-4) | throw — **`01:978-983` 표에 없다** |

그리고 **ingress 방향 raw 파싱 2곳**은 별개 범주다: `WsRouter.ts:1745`(`handleMessage` 하류의 `JSON.parse`), **`:2551` `tryParseRawMessage`(그 안의 `JSON.parse` 는 `:2553`)**.

> **정정**: 이전 판은 "4곳"이라 했고 `01:978-983` 은 "5곳"이라 했으나 `01` 의 5번째는 ingress(`tryParseRawMessage`) 이고 `:5846`(outbound) 이 빠져 있다. 위 표가 직접 확인한 정본이다. `02:450` 이 요구한 대로 **`handleMessageError`(시그니처 `:2534`, `tryParseRawMessage` 호출 `:2538`)와 `tryParseRawMessage`(시그니처 `:2551`, `JSON.parse` `:2553`)** 가 **바이너리 raw 에 `JSON.parse` 를 재시도하지 않도록** 확장하는 것은 S3 소관이다 (2차 검증 L-24 — 이전 판은 `:2534` 를 재파싱 지점 문맥에 섞었다).

**실패 방향이 서로 반대**라 부분 전환 시 "coalescing 은 죽고 큐 정리도 안 되는" 최악 조합이 나온다(`02:154`). → payload 재파싱 제거는 **이 프로젝트와 무관하게 옳은 수정**이므로 S1 에서 JSON 상태로 선행한다(`01:1182`, `02:519-530`).

### 1.5 최대 리스크는 프레임 설계가 아니라 **핀 5계열** — 전면 개정

이전 판은 핀을 2개(= `wsSendPolicy.ts`, `WsRouter.ts`)로 적었다. **최소 5계열이다.** 06 이 편집하는 파일에 걸린 핀을 전수 조사한 결과는 아래와 같다 (전부 직접 확인).

#### P1 — fair-scheduler `sourceDigest`

| 항목 | 값 |
|---|---|
| 정의 | `server/tools/write-fair-scheduler-source-provenance.mjs:7-14` (6개 파일) |
| 06 이 건드리는 것 | `src/ws/wsSendPolicy.ts`(`:10`), `src/ws/WsRouter.ts`(`:11`), **`src/benchmarks/terminalFairnessCharacterization.ts`(`:8`)** — ⚠️ **6차 검증 L-1 추가.** 이전 판은 앞의 둘만 열거했으나 **§7 항목 5 가 `terminalFairnessCharacterization.ts:1093`(`creditPayload.length` 로 바이트 임계 계산) 수정을 S5 에 배정하며 스스로 *"P1 재발행 유발"*(`02:529`) 이라 적는다.** 정의 6개 중 나머지 3개(`:9` `fairSchedulerAuthorityLocator.ts` · `:12` `TerminalResourcePolicy.ts` · `:13` `TerminalResourcePolicyCanary.ts`)는 어느 단계도 편집 대상으로 지목하지 않는다 — S5 는 resolver 의 **값을 재측정**할 뿐 `TerminalResourcePolicy.ts` 자체를 수정하지 않는다(§5 S5-a 말미 "타입을 건드리지 않는다"). **매트릭스가 S5 에 P1 을 ● 로 두므로 단계 배정에는 영향이 없고, 파일 열거만 불완전했다** |
| 읽는 방식 | **워킹트리 직접 읽기** — `:28` `readFile(resolve(serverRoot, path), 'utf8')` |
| 파급 | `terminalFairnessCharacterization.ts:1675` → `TerminalResourcePolicyCanary.ts:346/:279/:386/:584` → `WsRouter.ts:1956-1966` 이 capability 를 `accepted:false` 로 → 그 소켓은 **fair scheduler 를 우회해** `this.sendTo(ws, {type:'output', …})`(`WsRouter.ts:5159-5167`) 로 나간다. ⚠️ **"스케줄러 없이 직접 전송" 이 아니다** — `sendTo` 는 여전히 transport 큐를 거치며 우회되는 것은 **fair scheduler 뿐**이다(2차 검증 L-13). **fair scheduler 가 오류 없이 조용히 꺼진다** (`05:262-283`) |
| 건드리는 단계 | **S1 · S2.5 · S3 · S4 · S5 · S6** — ⚠️ **3차 검증-B M-2 정정.** 이전 판은 `S1 · S4 · S5 · S6` 라 적어 **S2.5 와 S3 를 빠뜨렸다.** 아래 매트릭스(`:174-182`)와 단계별 "핀 영향" 행(**S2.5 §5 S2.5 표 · S3 §5 S3 표**)이 둘 다 P1 을 ● 로 표시한다. **실무 영향: 두 단계 모두 `WsRouter.ts` 를 편집하므로, 상세표만 보고 진행하면 편집 후 republish 를 건너뛰어 build 가 red 인 채로 다음 단계에 들어간다** |
| 재핀 주체 | S0.5 에서 확립한 republish 절차 (§4 S0.5) |
| 확인 커맨드 | `npx tsx --test src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts` (cwd=`server/`) |

#### P2 — `canary-admission-evidence` 프로덕션 경로 해시

| 항목 | 값 |
|---|---|
| 정의 | `tools/wave3/canary-admission-evidence.test.mjs:37-56` `productionSourcePaths` → 해시는 `:473` `hashesFor(...)`. **아티팩트 레코드에 실리는 자리는 `:519` `implementationInputs: productionSourcePaths.map(...)` 이고, 실제 파일 쓰기는 `:552`(green 증거)·`:638`(artifact) 의 `writeFileSync` 다** — 둘 다 `--regenerate-green` 일 때만 쓰고 아니면 `assert.deepEqual` 로 **대조**한다(`:640-642`). 2차 검증 L-6 |
| 06 이 건드리는 것 | `WsRouter.ts`(`:46`), `wsSendPolicy.ts`(`:47`), **`server/src/types/ws-protocol.ts`(`:48`)**, **`frontend/src/contexts/WebSocketContext.tsx`(`:49`)**, **`frontend/src/types/ws-protocol.ts`(`:50`)**, **`frontend/src/components/Terminal/TerminalView.tsx`(`:52`)**, **`frontend/src/components/Terminal/TerminalContainer.tsx`(`:53`)**, **`frontend/src/utils/terminalOutputScheduler.ts`(`:54`)**, `frontend/src/utils/visibleOutputRecovery.ts`(`:55`) — ⚠️ **5차 검증 L-4 정정.** 이전 판은 `:52`·`:53` 을 빠뜨렸는데 **§5 S4-b 가 `TerminalContainer.tsx:3192-3443` `onOutput` 전체 재작성을 지시**하고(`03:756`) `TerminalView.tsx` 도 restore 버퍼 경로(`:1745` `bufferOutputWhileRestorePending`)로 S4 대상이다. **매트릭스가 S4 에 P2 를 ● 로 두므로 단계 배정에는 영향이 없고, 파일 열거만 불완전했다.** `:51` `TerminalRuntimeContext.tsx` 는 어느 단계도 편집 대상으로 지목하지 않아 그대로 둔다 |
| 추가 핀 | `:58-79` `focusedCommands` 가 **ws 테스트 파일명을 하드코딩**한다 (`WsRouterSendPriority` · `WsRouterRestoreMetadata` · `wsSendPolicyRestoreMetadata` · `TerminalResourcePolicyCanary` + frontend 4개) → **ws 테스트 파일 추가·개명 시 깨진다** |
| 건드리는 단계 | **S1 · S2(조건부 ○¹) · S2.5 · S3 · S4 · S5 · S6** — 진짜로 전 구간이다. ⚠️ **3차 검증-B M-2 정정.** 이전 판은 `S1 · S2 · S3 · S4 · S5` 라 적어 **S2.5 와 S6 를 빠뜨렸고**(단계별 "핀 영향" 행은 둘 다 P2 를 싣는다), 반대로 **S2 는 조건부인데 무조건으로 적었다**(각주 ¹) |
| 재핀 주체 | 각 단계 종료 시 담당자가 아티팩트 재생성 |
| 확인 커맨드 | `node tools/wave3/canary-admission-evidence.test.mjs` (루트, node:test 아님). **재발행 플래그는 `--regenerate-green`(`:16`)이고 이 파일에만 있다** (2차 검증 L-23) |

#### P3 — `authority-promotion-evidence` 프론트엔드 소스 해시

| 항목 | 값 |
|---|---|
| 정의 | `tools/wave3/authority-promotion-evidence.test.mjs:129-140` — **`frontend/src/contexts/WebSocketContext.tsx` 와 `frontend/src/types/ws-protocol.ts` 의 sha256** 포함. `:766-777` `readProductionGitStatus()` 가 `git status --porcelain` 출력까지 baseline 과 대조(`:816-819`) |
| 발동 조건 | `mode === 'red'` (`:2522`), mode 는 `--expect-red` 로만 red (`:2470`) → **기본(green) 실행에서는 안 돈다.** 이 파일의 플래그는 `--expect-red`·`--expect-green`·`--self-test`·`--self-test-composite-fixture` (`:2450` 부근) |
| **⚠️ git 의존 — 단 `--expect-red` 에서만** | `:766-777` `readProductionGitStatus()` 가 `git status --porcelain=v1` 을 실제로 실행한다 → **§2.1 의 "provenance 는 git 을 호출하지 않는다" 는 P1 에만 적용되고 P3 에는 적용되지 않는다** (2차 검증 H-4). ⚠️ **그러나 이 게이트는 무조건 돌지 않는다** (4차 M-2, 직접 확인): `readProductionGitStatus()` 의 **유일한 호출부는 `:816`** 이고 그것을 감싼 `verifyRedProductionUnchanged()`(`:779`)는 **`:2522` `const redProductionUnchanged = mode === 'red' ? verifyRedProductionUnchanged() : null;` 한 곳에서만** 호출된다. **프론트엔드 소스 sha256 핀(`redFrontendSourceBaseline` `:129`)도 같은 함수 안(`:804-805`)이라 동일하게 red 전용이다.** 즉 **워킹트리 dirty 는 `--expect-red` 실행에서만 red** 이며 기본(green) 실행에서는 dirty 여부를 보지 않는다 |
| 그러나 green 에서도 깨짐 | `:934`/`:938` 실 WS 프로브가 **모든 프레임을 무조건 `JSON.parse`** 한다 (`05:145`) |
| 건드리는 단계 | **S3 · S4** |
| 재핀 주체 | baseline 갱신 vs RED 증거 "superseded" 종결 → **D6 결정 필요**(`05:748`) |
| 확인 커맨드 | `node tools/wave3/authority-promotion-evidence.test.mjs` (루트). ⚠️ **Playwright E2E `wave3-terminal-authority-promotion.spec.ts` 까지 실행**하며 2222 에 서버가 없으면 `start.bat` 으로 프로덕션 서버를 띄운다 |

#### P4 — `retained-shadow-parity`

이전 판은 이 핀의 성격을 **틀리게** 적었다. 직접 확인한 사실:

| 항목 | 값 |
|---|---|
| 겉보기 핀 | `:18-23` `testSourcePaths` 4개 (`RetainedTerminalAuthority.test.ts` · `SessionManagerPartialEscapeTail.test.ts` · `WsRouterRestoreMetadata.test.ts` · `WsRouterCheckpointProtocol.test.ts`) |
| **그 해시는 게이트가 아니다** | `:319` 에서 계산 → **레코드 조립은 `:664-676`**(`inputHashes`/`configHashes`/`productionSourceHashes`/`coverageIdentity`) → `:679` writeFileSync → `:680` `assert.deepEqual(JSON.parse(readUtf8(artifactPath)), artifact)` — **방금 쓴 파일과 자기비교. vacuous**. ⚠️ `:509` 는 아티팩트 기록이 아니라 **coverage 본문 앵커 단정**(`assert.equal(testBody.includes(anchor), true, …)`)이다 (2차 검증 L-4) |
| **진짜 핀 1** | `expectedFocusedTestNamesSha256`(`:161`) ← **실행된 테스트 이름 집합**의 해시. 단정 `:454`(리터럴 대조) 및 **`:583`**(실제 실행 결과 대조) |
| **진짜 핀 2** | `assert.equal(expectedCoverageAxisIds.length, 42, ...)` (`:456`) + `thresholds.coverage.exactAxes === 42` (`:459`) |
| **프로덕션 소스 핀** | `:40-45` `productionSourcePaths` — `SessionManager.ts`(`:41`), `headlessTerminal.ts`(`:42`), **`server/src/types/ws-protocol.ts`(`:43`)**, **`server/src/ws/WsRouter.ts`(`:44`)** |
| 스위트 실행 | `:47-61` `focusedCommand` 가 `npx tsx --test` 로 **서버 테스트 4개를 spawn** 한다 (cwd=`server`) |
| **실무 반전** | 테스트 **본문** 수정은 안 깨진다(해시가 vacuous 하므로). **테스트 추가·개명이 깬다** — `:583` 이 실행된 이름 집합을 대조하기 때문. **S1 · S3 · S4 가 전부 그걸 한다** |
| 건드리는 단계 | **S1 · S2(조건부 ○¹) · S2.5 · S3 · S4** — ⚠️ **3차 검증-B M-2 정정.** 이전 판은 `S1 · S3 · S4` 라 적어 **S2.5 를 빠뜨렸다.** S2.5 는 `server/src/types/ws-protocol.ts` 를 확장하는데 그것이 P4 `productionSourcePaths`(`:43`)에 들어 있고, `.test.ts` 도 신설하므로 `:583` 의 실행 테스트 이름 집합 대조가 함께 걸린다 |
| 확인 커맨드 | `node tools/wave3/retained-shadow-parity.test.mjs` (루트, node:test 아님). **`--self-test` 는 `:575`**(`if (process.argv.includes('--self-test'))`)이고 `:670` 은 `axisIdsSha256:` 이다 (2차 검증 L-5). ⚠️ **`05:733`(U3)의 `[미확인]` 은 해소됐다 — `--regenerate-green` 은 이 파일에 0회이고 `canary-admission-evidence.test.mjs:16` 에만 있다**(전수 grep, 2차 검증 L-23). 즉 **P4 에는 재발행 플래그가 없다**; 재고정 수단은 `expectedFocusedTestNamesSha256`(`:161`) 리터럴 갱신뿐이다 |

#### P5 — 스케줄러 벤치마크 digest (이전 판 완전 누락)

| 항목 | 값 |
|---|---|
| 정의 | `frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts:25`(baseline) / **`:34`(candidate)** |
| 단정 | `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts:64` `assertFrozenImplementationSources()` — **`execFileSync` 호출은 `:66-73` 에 걸쳐 있고 `'show'` 리터럴이 `:69`, `` `${rev}:${path}` `` 가 `:70`** 이다(`:71-73` 은 `],` / `{ cwd: repositoryRoot },` / `);` 로 인자 종결). 즉 **`git show <rev>:<path>` 로 baseline 을**, **`:74-76` 은 `readFileSync(워킹트리)` 로 candidate** 를 읽어 `:78`/`:79` 에서 대조. ⚠️ 이전 판은 이 호출을 `:71-73` 이라 적었고 §2.1 은 `:69-70` 이라 적어 **같은 호출을 두 곳에서 다르게 인용**했다 — `:69-70` 이 맞다 (3차 검증 M-3) |
| **측정된 digest 3종** (직접 확인) | pinned candidate `:34` = `75716d66…` / **HEAD** = `dc1edf2a…` / **워킹트리** = `eb5a13be…` |
| 결정적 사실 | `:25` 의 pinned **wave-1 baseline 도 `dc1edf2a…`** — 즉 **HEAD 는 baseline 과 같고, pinned candidate 구현은 HEAD 에도 워킹트리에도 존재하지 않는다**(`03:648`). `:78` 은 통과하고 **`:79` 가 워킹트리 digest 를 pinned candidate 와 비교해 실패**한다 |
| 건드리는 단계 | **S4** — `enqueueBytes` 신설이 `terminalOutputScheduler.ts` 를 수정한다 |
| 재핀 주체 | **S4 착수 *전*에** 현행 스케줄러를 새 baseline 으로 재고정 (**`03:667` — `[설계결정]`**, `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1`). §2.1 범위 한정 참조: 이 게이트의 baseline 피연산자는 **`git show <rev>:<path>`** 로 오므로 **커밋 상태에 의존**한다 |
| 확인 커맨드 | `node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` (cwd=`frontend/`) |

> `03:651` — 이 게이트는 *"**스케줄러를 건드리는 모든 작업을 RED 로 만든다. `enqueueBytes` 추가도 예외가 아니다**"*. `03:775` — *"미조치 시 관련 작업 전부 RED"* — ⚠️ **이 셀은 `03:734` 가 표 전체에 일괄 부착한 `[추정]` 아래에 있다**(*"'난이도'와 '위험' 열은 전부 `[추정]`"*). 확정형으로 인용하지 않는다 (2차 검증 L-22). 그리고 `03:653` 의 **`[미확인]`**(*"워킹트리 변형이 wave-2 candidate 의 상위 집합인지 여부"*)도 함께 승계된다 — **재고정 후 무엇이 baseline 이 되는지가 아직 확정 아님.** 이전 판은 이것을 §4 표 한 줄로만 두고 담당·단계 연결이 없었다.

#### 핀 × 단계 매트릭스

| 단계 | P1 fair-sched | P2 canary | P3 promotion | P4 retained | P5 bench |
|---|:--:|:--:|:--:|:--:|:--:|
| S1 payload 재파싱 제거 | ● | ● | | ● | |
| S2 코덱 모듈 (신규 파일) | | ○¹ | | ○¹ | |
| S2.5 channel 등록부 | ● | ● | | ● | |
| S3 silent drop 제거 | ● | ● | ● | ● | |
| S4 송수신 배선 | ● | ● | ● | ● | **●** |
| S5 회계 재벤치 | ● | ● | | | |
| S6 롤백·기본값 | ● | ● | | | |

● = 확실히 건드림 · ○ = **조건부**(아래 각주)

¹ **S2 는 새 파일만 만들므로 핀 파일 diff 가 0 이다.** 그러나 **새 `*.test.ts` 파일 추가**가 P2 의 `focusedCommands`(`:58-79`) 목록과 P4 의 `expectedFocusedTestNamesSha256`(`:161`, 실행 결과 대조는 `:583`) 을 건드릴 수 있다. **새 테스트를 기존 focused 목록에 넣지 않으면 둘 다 회피된다** — `05:351` 의 "새 검증은 새 파일에" 원칙이 여기서 나온다. **이 회피를 지키는 한 S2 의 핀 영향은 0 이고**(§4 S2-f 표의 "핀 영향: 없음(새 파일)" 은 그 조건부 결론이다), 지키지 못하면 P2·P4 가 동시에 붙는다. 매트릭스의 ○ 두 칸과 S2 상세표는 **같은 조건문의 양쪽 가지**다 (2차 검증 M-5 — 이전 판은 매트릭스에 P2 만 ● 로 두고 상세표는 "없음"이라 해 서로 어긋났다).

⚠️ **매트릭스가 정본이다** (3차 검증-B M-2). 2차 검증에서 같은 종류의 불일치(매트릭스 ↔ S2 상세표)를 고쳤다고 적어 놓고, **핀 상세표 5개 중 3개(P1·P2·P4)의 "건드리는 단계" 행이 여전히 매트릭스·단계별 "핀 영향" 행과 어긋난 채 남아 있었다** — P3·P5 만 일치했다. 위 세 표를 매트릭스에 맞춰 정정했다. **이후 세 표(매트릭스 · 핀 상세표 · 단계별 "핀 영향" 행) 중 하나를 고치면 반드시 나머지 둘을 같이 고친다** — 이것은 같은 사실의 세 표현이고, 이번 판까지 **두 라운드 연속으로 어긋났다.**

**결론**: `wsSendPolicy.ts`/`WsRouter.ts` 는 저장하는 순간 P1 이 red 가 되고, 되돌리는 **republish CLI 가 저장소에 없다**(`05:293-297`). → **S0.5 republish 리허설이 첫 코드 작업보다 앞선다. 실패하면 착수 불가.**

---

## 2. 정정 — 반복 인용된 **세 개**의 틀린 전제

### 2.1 ⚠️ **fair-scheduler provenance/evidence-bundle 쌍**은 git 을 호출하지 않는다 — 그 쌍에 한해 커밋 순서 전제 폐기

`02:618` 과 `04:164`(및 그 반복인 `04:321`, `04:527`)는 *"provenance 는 워킹트리가 아니라 커밋된 상태를 기준으로 판단하는 지점이 있으므로 커밋 순서를 지키지 않으면 무한 루프에 빠진다"*, *"순서는 반드시 코드 커밋 → republish → 증거 커밋"* 이라고 적었다. **이것은 틀렸다.**

직접 확인한 사실:

- `server/tools/write-fair-scheduler-source-provenance.mjs` — import 는 `node:crypto`/`node:fs/promises`/`node:path`/`node:url` **4개뿐**(`:1-4`). `:28` 이 `readFile(resolve(serverRoot, path), 'utf8')` 로 **워킹트리를 직접 읽는다**
- `server/tools/write-fair-scheduler-evidence-bundle.mjs` — import 는 `node:crypto`/`node:fs`/`node:fs/promises`/`node:path`/`node:url` (`:1-5`). 파일시스템만 읽는다(`:126-128`, `:166`)
- **두 스크립트 어디에도 `node:child_process` import 나 `git` 호출이 없다** (전수 grep 0건)

`05:289-291` 이 이미 같은 결론에 도달했고 실무적 함의까지 적었다: *"HEAD 를 읽는다면 커밋 전까지는 게이트가 초록이겠지만, 워킹트리를 읽으므로 **저장하는 즉시** 게이트가 빨개진다. 커밋 순서로 회피할 수 없다."*

**왜 06 에 명시해야 하는가**: S0 이 `04` 초안으로 `PERF-BGSTAB-011` 을 저작하는데, **`04:321` 과 `04:527` 이 이 반박된 전제를 그대로 요구사항 본문(`PERF-BGSTAB-011` AC-7)에 써 넣게 만든다.** AC-7 초안(`04:310`)의 *"evidence bundle 재발행은 provenance 소스가 **커밋된 상태에서** 수행되어야 하며"* 는 성립하지 않는 조건을 stable 계약으로 굳히는 문장이다.

**[설계결정] S0 의 `PERF-BGSTAB-011` AC-7 은 다음으로 저작한다**: *"**fair-scheduler evidence bundle** 재발행 후 sha256 매니페스트 재검증이 통과해 server build 가 실패하지 않아야 한다."* — 커밋 순서 조항을 뺀다. 커밋 순서는 요구사항이 아니라 §4 S0.5 가 확립할 **운영 절차**다.

⚠️ **AC 문면에 "fair-scheduler evidence bundle" 이라는 한정어를 반드시 넣는다.** 한정어 없이 *"provenance 는 커밋 상태와 무관하다"* 류로 쓰면 **P3(`git status --porcelain=v1`)·P5(`git show <rev>:<path>`)가 그 자리에서 반증 사례가 된다**(§2.1 범위 한정). **AC 텍스트는 사후 편집 불가**(`04:18-31`)이므로 이 한정어를 빠뜨리면 되돌릴 수 없다.

> 메모리 `fair_scheduler_republish_procedure` 도 같은 오류를 담고 있다. 이 정정이 정본이다. `[미확인]` — 메모리·`02`·`04` 의 기술이 이전 리비전에 근거한 것인지(`05:732` U2).

#### ⚠️ 이 정정의 **범위 한정** (2차 검증 H-4)

**"provenance 는 git 을 호출하지 않는다" 를 저장소 전체로 일반화하면 안 된다.** 위 grep 0건 결과가 성립하는 것은 **`server/tools/write-fair-scheduler-source-provenance.mjs` 와 `write-fair-scheduler-evidence-bundle.mjs` 두 스크립트, 즉 P1 계열뿐**이다. 06 이 건드리는 다른 핀은 **git 을 직접 읽는다**:

| 핀 | git 사용 | 귀결 |
|---|---|---|
| **P3** `authority-promotion-evidence` | `:766-777` `readProductionGitStatus()` 가 **`git status --porcelain=v1`** 를 실행하고 `:816-819` 가 그 출력을 baseline 과 대조 | ⚠️ **`--expect-red` 실행에서만 걸린다** (4차 M-2 정정). 호출 사슬은 `:2522`(`mode === 'red'`) → `:779` `verifyRedProductionUnchanged()` → `:816` 이 **유일**하고, `mode` 는 `:2470` `args.includes('--expect-red')` 로만 `'red'` 가 된다. **그 실행에 한해** 워킹트리가 dirty 하면 커밋 여부와 무관하게 red 다. **기본(green) 실행은 git status 도 프론트 소스 sha256 핀(`:129`, 사용처 `:804-805`)도 보지 않는다** |
| **P5** 스케줄러 벤치 | `terminalOutputSchedulerBenchmark.test.ts:69-70` 이 **`git show <rev>:<path>`** 로 baseline 을, `:74-76` 이 `readFileSync(워킹트리)` 로 candidate 를 읽어 `:78`/`:79` 에서 대조 | **baseline 피연산자만 커밋 상태에서 온다.** 워킹트리 편집은 candidate 쪽만 움직인다 |

**그러므로 각 단계의 절차는 이렇게 갈린다.**
- **P1 (S0.5 republish)**: 커밋 순서 무관. 저장하는 즉시 red, republish 하는 즉시 green.
- **P3 (S3·S4)**: **`--expect-red` 실행에 한해** 워킹트리 dirty 자체가 red 다. **기본 실행(§S-1 그룹 7 · §1.5 P3 확인 커맨드)은 플래그가 없으므로 이 게이트를 타지 않는다** — 즉 "편집 → 즉시 재검증" 은 **기본 실행에서는 성립한다.** P3 가 기본 실행에서 깨지는 경로는 다른 것이다: `:938` 의 실 WS 프로브가 모든 프레임을 무조건 `JSON.parse` 하므로 **바이너리 프레임이 실제로 흐르기 시작하는 S4 부터** 깨진다. 따라서 P3 처분(D6)은 *"S3 첫 파일 저장 전"* 이 아니라 **"P3 범위 파일 변경을 커밋해 RED baseline 이 낡기 전, 그리고 다음 `--expect-red` 실행 전"** 이 실제 마감이다.
- **P5 (S4 선행)**: `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 재고정은 **S4 착수 전**, 즉 워킹트리가 아직 현행 스케줄러일 때 수행한다.

⚠️ **SRS 문구 개정 지시의 범위도 여기에 맞춘다.** 아래 `PERF-BGSTAB-011` AC-7 저작 지침은 **P1(fair-scheduler evidence bundle)에만 적용**된다. 범위 한정 없이 "provenance 는 커밋 상태와 무관하다" 를 AC 로 굳히면 **P3·P5 를 반증 사례로 안고 있는 거짓 계약**이 된다.

### 2.2 ⚠️ `REL-BGSTAB-007` AC-4 개정은 "연기"가 아니라 **차단 항목 삭제**였다

이전 판 §2.1 은 설정 키 결정으로 *"실제 문면 충돌이 `FR-BGSTAB-008` AC-5 **1건으로 축소**된다"* 고 단언했다. 그러나:

- `00:59` 가 `REL-BGSTAB-007` AC-4 를 **개정 대상**으로 등재했다 (`Stability=stable`)
- `01:1181` 이 이를 **선행 #2 — "unified 바이너리의 선행"** 으로 명시했다
- `02:694` 도 "개정 대상" 으로 분류했다

이전 판에는 이 항목이 **문자열조차 없다.** 그리고 speckiwi 는 AC 텍스트를 편집할 수 없으므로(`04:18-31`, 결론은 **`04:141`** — `04:135` 는 빈 줄이다, 2차 검증 L-10), 이것은 **연기가 아니라 차단 항목의 삭제**였다.

**실제 상태 (정본: `04:150-156`)**: AC-4 원문은 *"**JSON wire에서는** canonical unsigned decimal string으로만"* 이라 조건절이 JSON wire 로 한정되어 있다 → 바이너리 표현은 **모순이 아니라 미규정 공백**이다. `01:224` 가 최소 개정안(절 추가)을 제시했고, `04:155` 는 **개정 대신 신규 REQ 가 공백을 메우는 방식**(`IR-BGSTAB-001` AC-2 + `extends` trace)을 택했다.

**[설계결정] `04:155` 방식을 채택한다.** 단 이전 판처럼 "충돌 1건"이라 말하지 않는다. **정직한 서술은 이것이다**:

| REQ | 상태 |
|---|---|
| `FR-BGSTAB-008` AC-5 | **문면 충돌.** 닫힌 열거에 키 추가 필요. 도구로 못 고침 → 노트 + `refines` 로 우회, **문면과 구현 불일치가 남는다**(`04:589`) |
| `REL-BGSTAB-007` AC-4 | **미규정 공백.** 신규 REQ 가 메움. 문면은 계속 참 |
| `PERF-BGSTAB-009` AC-7 | §11 M-16 참조 — **`02:419`/`02:695` 는 "개정 불필요"로 결론**했다 |

### 2.3 ⚠️ **`05` 는 21B 초안 위에 쓰였다** — "05 가 정본" 인용에는 항상 이 단서를 단다 (2차 검증 CRITICAL)

이 계획은 여러 곳에서 `05` 를 정본으로 지목한다. **그 지위는 유효하되, `05` 의 프레임 크기 숫자는 전부 폐기된 21B 초안 기준이다.** `02` 에 대해서만 오염을 정정하고(§10.3) `05` 에는 무조건 정본 지위를 준 것이 이전 판의 결함이다.

**직접 확인한 21B 의존 지점 전수:**

| 위치 | 내용 |
|---|---|
| `05:16` | `[opcode 1B][channelId 4B][streamEpoch 4B][sourceSeq 8B][length 4B][payload]` **(고정 헤더 21B)** — 문서 전체의 전제 |
| `05:100` | *"**초안 헤더 21바이트로는 이 필드들이 다 안 들어간다**"* → `01` §1.8 프롤로그로 해소됨(§3.2 D2) |
| `05:201` | D1 안 B = *"헤더 **21B** 포함"* |
| `05:428` | P2 = `encode(m).length === **21** + payloadBytes(m)` |
| `05:460` | F1 경계 대조군 = *"**21바이트**(헤더만, payload 0) → 성공해야 함"* |
| `05:734` | U4 = *"**초안 헤더 21B** 에 안 들어감"* |

**처분:**

| `05` 의 부분 | 지위 |
|---|---|
| 프레임 **크기 산수**(P2, F1 대조군, U4, D1 안 B 의 21B) | **폐기.** §4 S2-b 의 28B 표가 정본 |
| fault 의 **종류**와 경계 대조군의 **논리**(`05:454-469`) | **유효.** 숫자만 교체 |
| 골든 벡터 전략(`05:437-452`) · 테스트 영향 분류(`05:132-176`) · 회귀 커맨드(`05:378-411`) · 매트릭스 M1~M6(`05:512-521`) · 롤백 R1~R7(`05:619-627`) · 사다리(`05:539-584`) | **유효** — 헤더 크기와 무관 |

> **`05` 파일 자체는 수정하지 않는다** (산출 요건). 이 절과 §4 S2-b 가 정정본을 보유하며, `05` 를 인용하는 모든 곳에서 이 절을 참조한다.

---

## 3. 결정 게이트 — **두 층으로 나눈다** (2차 검증 H-5)

`05` §12 체크리스트가 D1–D9 를 착수 전 항목으로 지정했다. 이전 판은 이를 통째로 빠뜨렸다가, 복원하면서 이번에는 **"전건 착수 전 확정 필수"** 라 선언해 놓고 **자기 표에서는 D4·D6·D8·D9 를 착수 이후로 미뤄** 내부 모순을 만들었다. 정정한다.

| 층 | 대상 | 시점 |
|---|---|---|
| **층 A — 프로젝트 착수 전 (하드 게이트)** | **D1**(회계 도메인 — §3.1-A **및 §3.1-B** 포함) · **D2**(해소됨) · **D3**(codec × mode) · **D5**(롤백 수렴점) · **D10**(협상 메시지 이름) · **D11**(`FR-BGSTAB-017` 배정) · **D12**(4값 사다리) | S0 SRS 저작의 **입력**이다. AC 텍스트는 사후 편집 불가(`04:18-31`)이므로 여기서 못 정하면 잘못된 계약이 굳는다. ⚠️ **층 A 안에도 순서가 있다** (4차 검증 L-6): **D3·D12 는 `realtime.terminalWireFormat` 키 존재를 전제**하고 그 키 신설 승인이 **Q2**(§3.4, 출처 `04:598`)이므로, **Q2 가 D3·D12 보다 선행한다.** Q2 거부 시 D12 는 무효가 되고 D3 는 codec 축을 표현할 자리를 잃어 형태가 바뀐다. 순서는 §13 층 A 체크리스트가 정본이다 |
| **층 B — 단계별 게이트** | **D4**(fixture 위치) · **D7**(생성기) → **S2 착수 전** · **D9**(opcode 공간) → **S2 착수 전** · **D6**(RED 증거 처분) → **S3 착수 전** · **D8**(CI 러너 OS) → §12 CI 도입 시 | 해당 단계의 **진입 조건**이며 프로젝트 착수를 막지 않는다 |

⚠️ **D6 의 마감을 과하게 당기지 않는다** (4차 M-2 정정). 이전 판은 *"P3 는 워킹트리 dirty 자체가 red 이므로 D6 의 실제 마감은 **S3 의 첫 파일 저장 전**"* 이라 적었다. **전제가 틀렸다** — 그 게이트는 `--expect-red` 전용이다(§1.5 P3 상세 · §2.1 범위 한정, 호출 사슬 `:2470` → `:2522` → `:779` → `:816`). 기본 실행에서는 워킹트리 dirty 를 보지 않으므로 **S3 의 첫 저장이 D6 을 강제하지 않는다.**

**정확한 마감 두 가지** (둘 중 먼저 오는 쪽):
1. **P3 범위 파일의 변경을 커밋하기 전** — 커밋하면 RED baseline(`redFrontendSourceBaseline` `:129` · `redExpectedProductionGitStatusLines` `:147`)이 낡고, 그 이후에는 "baseline 갱신" 과 "superseded 종결" 중 어느 쪽을 택했든 사후 재구성 비용이 든다
2. **다음 `--expect-red` 실행 전**

**그리고 기본 실행에서 P3 가 깨지는 진짜 시점은 S4 다** — `:938` 의 실 WS 프로브가 모든 프레임을 무조건 `JSON.parse` 하므로(`05:145`) 바이너리가 실제로 와이어에 나가기 시작해야 걸린다. 층 A 로 올리지 않는 이유는 D6 이 SRS AC 문면에 들어가지 않기 때문이며, 이 정정으로 **S3 착수와 동시라는 압박이 사라진다.**

D10–D12 는 이번 검증에서 추가된 것이다.

### 3.1 D1 — ACK credit encoded-byte 도메인 ⚠️ **이전 판이 `05` 권고와 반대로 확정하고 충돌을 숨겼다**

`05:200-204` 는 3-way `[설계결정]` 으로 제시하고 **A(payload 바이트만)를 권고**했다. 이전 판 §2.2 는 근거 제시 없이 **B(헤더 포함 와이어 바이트)** 로 확정했다.

| 안 | 내용 | `05` 의 평가 |
|---|---|---|
| **A. payload 바이트만** | 봉투/헤더 제외 | **권고.** *"크레딧 산수가 단계마다 흔들리지 않는다"* (`05:204`). 인코딩 독립 |
| B. 와이어 전체 바이트 | 헤더 포함 | *"같은 크레딧으로 더 많이 흐름 = **사실상 백프레셔 완화**"* (`05:201`). ⚠️ `05:201` 원문은 *"헤더 **21B** 포함"* — 21B 오염(§2.3). **확정값은 28B + 프롤로그**이며 §4.2 가 그 값을 쓴다. 오염은 논증의 방향이 아니라 크기만 바꾼다(28B 면 완화 폭이 21B 때보다 **작다**) |
| C. JSON 기준 고정 | 계약 안정 | shadow 이후 순 낭비 (`05:202`) |

교차 근거: `03:406` 도 같은 질문을 클라이언트 측에서 `[미확인]` 으로 열어 두고 *"둘 다 취할 수는 없다"* 고 못 박았다 — 서버 큐 예산은 봉투 포함 바이트(`wsSendPolicy.ts:95`), 클라이언트 예산은 payload 바이트로 **이미 어긋나 있다**(`03:432`).

반대 근거도 있다: `02:236-243` 은 `WsRouter.ts:6098` 의 `bufferedAmount + message.byteLength` 가 성립하려면 두 항이 같은 도메인이어야 하므로 `byteLength` 가 헤더를 **포함해야** 한다고 본다.

**[설계결정] 두 값을 분리한다.** 실은 하나의 필드가 아니다.

- `WsTransportMessage.byteLength` (백프레셔·큐 예산) = **와이어 전체 바이트**. `bufferedAmount` 와 도메인 일치 필요 (`02:236`)
- `FairTerminalDelivery.encodedBytes` (ACK credit ledger, `wsSendPolicy.ts:510`) = **본문(body) 바이트만** — 헤더 28B · 프롤로그 · 세그먼트 배열 제외. `05:204` 의 A 를 28B 프레임에 적용한 형태다 (§4.2 참조: 프롤로그 크기가 opcode 별로 달라 그것까지 빼야 "인코딩 불변" 이 성립한다). ⚠️ **이 규정은 바이너리 codec 전용이 아니다** — **JSON codec 도 같은 도메인으로 전환**하며 시점은 S5 다. **현행은 봉투 포함**(`wsSendPolicy.ts:598-611` → `:91`/`:95`)이므로 이것은 무수정 항목이 아니라 **변경 항목**이다. 근거·시점·비용은 §3.1-B

두 값이 다르다는 사실 자체를 `IR-BGSTAB-001`/`PERF-BGSTAB-011` AC 에 명문화한다. **이것이 D1 의 결론이며 S0 SRS 저작의 입력이다.** 이전 판처럼 "무수정"이라 단언하지 않는다 — §11 M-5 참조.

🚫 **이 결론만 읽고 S0 에 들어가지 말 것.** 이 결정은 **`01`·`02`·`00` 세 정본과 정면 충돌**하며, 그 기각 사유는 **바로 아래 §3.1-A** 가, **기각 사유가 성립하기 위한 전제(JSON codec 측 도메인 규정)는 §3.1-B** 가 보유한다. **§3.1-A · §3.1-B 는 D1 의 부록이 아니라 D1 의 일부**이며, **셋 중 하나라도 빠지면 나머지가 논거를 잃는다** (4차 검증 H-1).

#### 3.1-A ⚠️ **D1 은 세 정본과 정면 충돌한다 — 명시 기각 없이 S0 에 들어가면 안 된다** (3차 검증-B HIGH)

이전 판은 위 결론을 `05:204`(A안 권고)와 `03:406` 만 근거로 확정하고, **정반대를 규정한 세 정본을 한 번도 인용하지 않았다.** 세 곳 전부 직접 열어 재확인했다.

| 정본 | 원문 (직접 인용) | 06 문서 전체에서의 인용 횟수 (전수 grep) |
|---|---|---|
| **`01:728`** `[설계결정]` | *"바이너리 그룹에서 `encodedBytes` 는 **바이너리 프레임 전체 길이(28 + 프롤로그 + 본문)** 로 재정의한다. **배치면 배치 전체 길이다.**"* | **0회** (이전 판 기준) |
| **`02:243`** | `\| encodedBytes (fair) \| **21 + payload.byteLength** (헤더 포함) \| 결정 기록 §3 "ACK credit 은 encoded byte 단일 domain". **클라이언트가 ACK 시 보고할 바이트도 수신 프레임 전체 크기여야 함** \|` | **0회** |
| **`00:78`** (§3 "이 결정이 무효화하지 **않는** 것") | *"**프레임 계약** — `channelId` / `streamEpoch` / `sourceSeq` / payload length / opcode, **ACK credit 은 encoded byte 단일 domain.**"* | **0회** |

**그리고 이전 판은 전제를 버린 채 귀결만 인용했다.** §5 S5-a 말미가 `01:732` 를 인용해 *"숫자를 그대로 두면 실효 창이 몇 배 커진다"* 로 S5 재벤치를 정당화하는데, **`01:732` 는 `01:728` 의 재정의에서 파생된 문단**이다(`01:730` *"이 변경의 파급이 크므로 명시한다:"* 아래 1번 항목). 전제(전체 길이 도메인)를 기각하고 귀결만 쓰면 논거가 공중에 뜬다.

**파급이 되돌릴 수 없다**: D1 은 층 A 하드 게이트이고, 그 결론이 `IR-BGSTAB-001`/`PERF-BGSTAB-011` 의 **AC 텍스트로 저작**되며, **AC 텍스트는 speckiwi 로 사후 편집할 수 없다**(`04:18-31`). 충돌을 표면화하지 않은 채 저작하면 stable 계약이 세 정본과 어긋난 채 굳는다.

##### 기각 판정 — 결정은 바꾸지 않고, 사유를 남긴다

**[설계결정] `01:728` 과 `02:243` 을 기각한다. `00:78` 은 기각하지 않고 재해석한다.** 셋의 처분이 서로 다르므로 분리해 적는다.

| 정본 | 처분 | 사유 |
|---|---|---|
| **`02:243`** | **기각 (무조건)** | 근거 숫자 `21 + payload.byteLength` 가 **폐기된 21B 초안**이다(§2.3 과 동일한 오염). 그리고 이 행은 §3.1 이 이미 채택한 **`byteLength` 쪽 결론**(= 와이어 전체)을 `encodedBytes` 에 그대로 복사한 것이며, `02:236` 이 실제로 논증한 것은 **`bufferedAmount` 와의 도메인 일치**뿐이다 — 그 논증은 `byteLength` 에만 적용되고 ACK 원장에는 적용되지 않는다. **하나의 논거로 두 필드를 동시에 확정한 것이 `02` 의 오류다** |
| **`01:728`** | **기각 (한정)** | `01:728` 자체는 21B 오염이 없고(28 + 프롤로그 + 본문) 논리적으로 일관된 대안이다. 기각 사유는 **`05:204` 의 "인코딩 불변" 요건과 양립 불가**라는 것 하나다: 프롤로그 크기가 opcode 별로 다르고(OUTPUT 24B `01:488` / SCREEN_SNAPSHOT 24B `01:516` / **CHECKPOINT_CHUNK 12B `01:522`**), 배치 경계는 `bulkSliceBytes` 와 lane 경계에 따라 흔들리므로(`01:1411-1415`), 전체 길이 도메인은 **같은 터미널 출력이 배치 방식에 따라 다른 크레딧을 소모**하게 만든다. `05:204` 가 요구한 *"단계마다 크레딧 산수가 흔들리지 않는다"* 가 정확히 여기서 깨진다. **단 "배치면 배치 전체 길이다" 라는 `01:728` 의 배치 규정 자체는 기각 대상이 아니다** — 그것은 `byteLength` 쪽에서 그대로 채택한다(§4.2, M-1). 🚫 **이 사유는 §3.1-B(JSON codec 측 도메인 규정) 없이는 성립하지 않는다** — 4차 검증 H-1. 반드시 함께 읽는다 |
| **`00:78`** | **기각하지 않는다. 본문-only 도 이 조항을 만족한다** | 아래 참조 |

##### `00:78` 과의 양립 — 조항 개정은 **불필요**하다

⚠️ **"단일 domain" 의 뜻을 하나로 고정한다** (4차 M-1). 이전 판은 같은 논증 안에서 이 말을 **두 뜻으로** 썼다 — 앞 문장은 *"서버 원장과 클라이언트 ACK 보고가 둘 다 본문 바이트를 쓰는 한"* (= **양측 일치**), 뒷 문장은 *"C안은 **와이어 인코딩과 크레딧 도메인**을 영구히 갈라놓는다"* (= **와이어 ↔ 크레딧 일치**). 두 뜻은 양립하지 않는다: 앞 뜻이면 C안(`05:202` — 서버·클라이언트 **양측 모두** JSON 바이트)도 `00:78` 을 만족해 기각 근거가 없어지고, 뒷 뜻이면 **본문-only 자신이 위반**한다(와이어 = 28 + 프롤로그 + 본문, 크레딧 = 본문). 하드 게이트의 기각 논증이므로 뜻을 하나로 못 박는다.

**[설계결정] `00:78` 의 "단일 domain" = 서버 원장과 클라이언트 ACK 보고가 같은 수를 센다.** 와이어 인코딩과의 일치는 `00:78` 이 요구하지 않는다 — 원문에 "프레임 전체" 도 "헤더 포함" 도 "와이어" 도 없고, 조항이 서 있는 자리는 §3 "이 결정이 무효화하지 **않는** 것" 즉 **ACK 프로토콜의 계약**이다. 이 정의를 §4.2 (`byteLength` ≠ `encodedBytes`)와 나란히 읽으면 일관된다: **두 값이 다른 층위라는 것 자체가 `00:78` 과 무관**하다.

이 정의 위에서:

- **본문-only 는 `00:78` 을 만족한다.** 서버 원장과 클라이언트 ACK 보고가 둘 다 본문 바이트를 쓰기 때문이다. 오히려 프롤로그 크기가 opcode 별로 다른 만큼, 전체 길이 도메인 쪽이 **클라이언트가 프롤로그 표를 정확히 구현해야만** 같은 숫자에 도달한다 — 구현 불일치가 곧 양측 불일치가 되는 구조다
- ⚠️ **그러므로 C안(`05:202`)의 기각 근거는 `00:78` 이 아니다.** C안도 양측이 같은 수를 세므로 `00:78` 은 만족한다. **C안이 기각된 사유는 `05:202` 자신이 적은 것 하나뿐** — *"shadow 단계 이후에는 순 낭비"* (두 인코딩을 영구히 둘 다 계산해야 한다). §3.1 표의 기각 사유가 그것이고, 이전 판이 여기서 `00:78` 위반을 덧붙인 것은 **근거 없는 가중**이었다. 정정한다
- ⚠️ **`02:243` 이 근거로 든 두 번째 문장** — *"클라이언트가 ACK 시 보고할 바이트도 **수신 프레임 전체 크기**여야 함"* — 은 `00:78` 에서 도출되지 **않는다.** `00:78` 은 **같은 수를 세라**고만 요구하고 그 수가 무엇인지는 정하지 않는다. **`02:243` 의 이 문장은 `00:78` 의 확대 해석이며, 그 확대 해석을 기각하는 것이 이 절의 실질이다**

**→ `00:78`(결정 기록 §3)은 개정하지 않는다.** `00` 파일 수정 금지 요건과도 충돌하지 않는다.

#### 3.1-B ⚠️ **JSON codec 의 `encodedBytes` 도 규정해야 한다 — 안 하면 §3.1-A 의 기각 근거가 무너진다** (4차 검증 HIGH)

**이전 판은 바이너리 codec 의 `encodedBytes` 만 정하고 JSON codec 측을 한 번도 규정하지 않았다.** 그 공백이 문서 안에서 두 개의 모순으로 드러나 있었다.

**모순 1 — 기각 근거의 자기부정.** §4.2 는 본문-only 채택 사유를 *"`05:204` 의 A안이 요구하는 **인코딩 불변**"* 으로 못 박고, §3.1-A 는 그것을 `01:728` 기각의 **단 하나의** 사유로 쓴다. 그런데 `05:204` 원문이 말하는 "불변" 은 **JSON↔바이너리 전환에 대한 불변**이다 (직접 인용): *"payload 바이트는 **인코딩 전환에 불변**이므로, §8 의 shadow/opt-in/기본값 단계에서 **크레딧 산수가 단계마다 흔들리지 않는다.**"* 반면 §5 S5-a 말미는 정반대를 주장했다 — *"본문-only 쪽이 **창 확대 폭이 더 크고** … 백프레셔가 늦게 걸린다 는 더 강하게 성립한다."* **창이 확대된다 = 같은 내용의 크레딧 소모량이 전환 전후로 달라진다 = 인코딩 불변의 부정.** 두 서술은 양립하지 않는다.

**모순 2 — 현행 구현은 봉투 포함이다** (직접 확인):

| 위치 | 코드 |
|---|---|
| `wsSendPolicy.ts:598` | `function fairDeliveryBytes(input, deliverySeq): number {` |
| `:599-609` | `return createWsTransportMessage({ type:'output', sessionId, data: input.payload, connectionEpoch, deliverySeq, deliveryKind, screenSeq, authorityEpoch, authorityRevision, chunkId })` |
| **`:610`** | `}).byteLength;` |
| `:91` / `:95` | 그 `byteLength` 의 정체 — `const payload = JSON.stringify(wireMessage);` / `byteLength: Buffer.byteLength(payload,'utf8')` |

즉 **오늘의 `FairTerminalDelivery.encodedBytes`(`wsSendPolicy.ts:510`)는 JSON 봉투 전체 바이트다.** 그대로 두고 바이너리만 본문-only 로 가면 **크레딧 도메인이 codec 별로 갈린다.**

##### [설계결정] 두 codec 모두 본문-only. JSON 측 전환 시점은 **S5** 다

| 항목 | 결정 |
|---|---|
| **도메인** | `encodedBytes` = **본문(body) 바이트**. **codec 무관** — JSON 경로도 `Buffer.byteLength(input.payload,'utf8')` 로 바꾼다. `fairDeliveryBytes()`(`wsSendPolicy.ts:598-611`)의 `createWsTransportMessage` 재호출이 사라진다(§5 S4-a ② 의 CPU 이득 항목과 같은 편집) |
| **전환 시점** | **S5.** 그 앞 단계에서는 codec 이 갈릴 수 없다 — **S4 는 `binary-shadow` 라 바이너리를 계산만 하고 와이어에 내보내지 않으므로**(`05:554-562`), **바이너리 delivery 가 크레딧을 소모하는 최초 시점이 `binary-optin`(S5-c)** 이다. 그전까지 원장에 기록되는 것은 JSON delivery 뿐이므로 도메인 분열이 실재하지 않는다 |
| **`05:204` 인코딩 불변** | **S5 전환 이후 성립.** 전환 후에는 같은 터미널 출력이 JSON 이든 바이너리든 **같은 크레딧**을 소모한다 → `01:728` 기각 사유(§3.1-A)가 실제로 선다 |
| **`00:78` 단일 domain** | **어느 시점에도 위반 없음.** S5 이전엔 codec 이 하나뿐이고, S5 이후엔 두 codec 이 같은 도메인이다 |
| **shadow parity 와의 관계** | S4-d 의 parity 축은 *의미 불일치·CPU·바이트 절감 예측·capability accepted 비율* 넷이고 **크레딧 숫자는 축이 아니다**(§5 S4-d 측정 항목). 따라서 도메인 전환을 S5 로 미뤄도 shadow 비교가 깨지지 않는다 |

**이 전환이 S5 에 있어야 하는 적극적 이유**: S5 진입 시점에는 아직 **JSON 이 유일한 와이어 포맷**이다. 즉 **도메인 전환의 효과를 인코딩 전환과 분리해 단독으로 측정할 수 있다** — `creditWindowBytes` 가 얼마나 넓어지는지를 JSON 상태에서 먼저 재고, 그 다음에 opt-in 을 켠다. 두 변화를 한꺼번에 켜면 §5 S5-c 가 경고한 *"바이너리 전환의 효과가 아니라 다른 것을 측정하는"* 함정에 그대로 걸린다.

**비용 — 숨기지 않는다**:
- `FairTerminalDeliveryScheduler.test.ts` 의 크레딧 단정(`:470`·`:471`·`:478`·`:479`)이 **값이 바뀐다.** §7 항목 1 의 리터럴이 봉투값(S1) → 본문값(S5)으로 **한 번 더 교체**된다는 뜻이다 (§7 항목 1 주)
- `PERF-BGSTAB-010` AC-5 원문(`30.*:3677`)은 *"실제 encodedBytes ledger"* 라고만 하고 도메인을 고정하지 않으므로 **AC 위반은 아니다.** 다만 그 REQ 의 검증 증거 중 크레딧 수치에 의존하는 것은 재수집 대상이다 `[추정]` — 증거 목록 대조는 S5 착수 시 수행
- `creditWindowBytes` 재측정이 **선택이 아니라 필수**가 된다 (§5 S5-a #7)

##### 프롤로그-only 프레임의 0B 크레딧 — 처분

본문-only 에서 **본문이 0 바이트인 프레임의 크레딧은 0** 이다. 이것은 가상의 사례가 아니라 이 문서가 이미 두 곳에서 **정상 프레임으로 규정한 것**이다: §4 S2-b 의 **F1 경계 대조군(52바이트 최소 유효 OUTPUT, `payloadLength=24`, 본문 0)** 과 **P7 정정본(`payloadLength === 24` 왕복)**. 그 프레임들은 `creditWindowBytes`(= `perClientOutputQueueMaxBytes`, `TerminalResourcePolicy.ts:57-59` `value: outputLimit`) 예산을 **전혀 소비하지 않는다.**

**[설계결정] 무한정 전송은 아니다. 다만 그 상한은 크레딧 원장이 아니라 다른 층이 준다.**

| 질문 | 답 |
|---|---|
| floor **없이** 두면 크레딧 원장이 프레임 수를 묶는가 | **아니다.** 본문 0 이면 소모 0 이므로 원장은 프레임 수에 상한을 주지 않는다 |
| **floor 1 을 채택한 뒤에는?** | ⚠️ **묶는다** (5차 검증 L-6 정정). delivery 당 최소 1 B 를 계상하므로 `:701` `lane.socketQueuedBytes + delivery.encodedBytes > creditWindowBytes.value` 가 **미확인 delivery 수를 `creditWindowBytes` 개로**, `:758` `lane.queuedBytes + encodedBytes > queueMaxBytes.value` 가 **큐 적재 수를 `queueMaxBytes` 개로** 묶는다. 이전 판의 1행은 **floor 없는 전제의 답**을 3행이 floor 를 채택한 뒤에도 그대로 두어 표 안에서 어긋나 있었다 |
| 그러면 무한정 나가는가 | **아니다. 상한이 두 도메인 모두에서 온다.** ① 위의 크레딧/큐 상한(**`encodedBytes` 도메인** — `:701`·`:758` 의 피연산자는 `byteLength` 가 아니라 `encodedBytes` 다, 직접 확인) ② `WsRouter.ts:6098-6099` `bufferedAmount + message.byteLength >= limits.serverBufferedHardLimitBytes` 백프레셔 게이트(**와이어 도메인**, 프레임당 52 B 이상). ⚠️ **어느 쪽이 실효 상한인지는 *구성 의존*이다 — 무조건으로 쓰면 반증된다** (6차 검증 H-3, 직접 확인). 두 상한은 **서로 다른 설정 키**에서 오고 스키마가 둘의 관계를 제약하지 않는다:<br>• ① = `creditWindowBytes` = `perClientOutputQueueMaxBytes` — 범위 `[1024, 268435456]`, 기본 **2,097,152** (`config.schema.ts:124`)<br>• ② = `serverBufferedHardLimitBytes` — 범위 `[1024, 536870912]`, 기본 **33,554,432** (`config.schema.ts:123`). ⚠️ **단 이 게이트는 `wsSendMode` 에 종속된다 — 아래 참조**<br>• `config.schema.ts:127-135` 의 `superRefine` 은 `serverBufferedHardLimitBytes > serverBufferedHighWaterBytes` 만 강제하고 **①과 ②의 관계는 제약하지 않는다**<br>⚠️ **②로 지목한 게이트는 스키마 기본 배포에서 아예 평가되지 않는다** (7차 검증 H-1, 직접 확인). `config.schema.ts:201` `wsSendMode: z.enum(['direct','safe-send-observe','safe-send-enforce']).default('direct')` 이고, `WsRouter.ts:6086-6094` 가 `mode === 'direct'` 일 때 `:6097` **이전에 early return** 하므로 `:6098-6099` `bufferedAmount + message.byteLength >= limits.serverBufferedHardLimitBytes` 에 **도달하지 않는다.** `safe-send-observe` 도 상한을 닫지 않는다 — `:6100-6103` 은 `transportBackpressureObserveCount` 만 올리고 `sendRawTransportMessage(ws, message)` 로 **그대로 내보낸다.** 실제로 닫는 것은 `:6105` `closeBackpressuredClient(ws, 'server-buffered-hard-limit')` 로 가는 **`safe-send-enforce` 하나뿐**이다<br>**그래도 `byteLength` 도메인 상한 자체는 direct 모드에도 있다** — `:6089` 가 `enqueueTransportMessage(ws, directState, message)` 를 호출하고 그 4번째 인자 기본값이 `:6158` `outputQueueMaxBytes = this.getEffectiveOutputQueueLimit(ws, message)`(`:5761-5763` — canary 미적용 시 `this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes`)이며, 강제는 `:6169` `nextOutputBytes > outputQueueMaxBytes` 와 `:6182` `state.outputBytes + message.byteLength > outputQueueMaxBytes` 다. 피연산자가 `message.byteLength` 이므로 **도메인은 여전히 ②쪽**이다. ⚠️ **다만 두 가지가 약해진다**: (a) 그 상한값이 direct 모드에서 ①과 ***같은 설정 키*(`perClientOutputQueueMaxBytes`)에서 온다** — *"두 상한은 서로 다른 설정 키에서 온다"* 는 서술도 `wsSendMode` 종속이다. (b) direct 모드의 그 경로는 **큐가 이미 비어 있지 않을 때만** 탄다(`:6088` `directState.sending \|\| hasTransportQueuedMessages(directState)`) — 큐가 한가하면 `:6093` `sendRawTransportMessage` 로 **상한 검사 없이** 나간다. 즉 direct 모드에서 ②가 묶는 것은 **적재량**이지 총 프레임 수가 아니다<br>**귀결**: 이전 판의 *"기본 배포 구성에서는 ②가 실효 상한 — ② ≈ 33,554,432 / 52 ≈ 645,277 프레임 < ① 2,097,152 delivery"* 는 **성립하지 않는다**(게이트 미도달). 그 산수는 `wsSendMode='safe-send-enforce'` 를 전제로 할 때만 뜻이 있고, 그 전제 위에서의 **합법 구성 반증**(`perClientOutputQueueMaxBytes=1024` · `serverBufferedHardLimitBytes=536,870,912` → ① **1,024** < ② ≈ **10,324,440**)은 여전히 유효하다. ⚠️ **그러므로 *"프레임 수 상한은 `byteLength` 도메인 소관"* 도(5차 L-6), *"실효 상한은 `byteLength` 쪽이 준다"* 도(6차 H-3), **특정 설정 키를 이름으로 지목하는 것**도(7차 H-1) 무조건 명제로 쓰면 안 된다.** 참인 무조건 명제는 **"`encodedBytes` 도메인과 `byteLength` 도메인이 각각 상한을 준다"** 하나뿐이다 — **도메인 수준**에서만 참이고, 어느 키가 그 상한을 주는지는 `wsSendMode` 와 두 키의 상대 크기에 달렸다 |
| 그래도 원장에 손을 대는가 | **[설계결정] per-delivery floor `max(bodyBytes, 1)` 을 둔다. 이유는 예산이다** — ⚠️ **이전 판의 사유(*"AC-6 의 duplicate/over-ACK 판정이 `deliverySeq` 에만 의존하게 된다"*)는 코드로 반증된다** (5차 검증 M-1, 직접 확인): `wsSendPolicy.ts:836` `if (input.deliverySeq <= lane.lastAcknowledgedSeq) return recordError('ACK_DUPLICATE', …)` / `:837` `if (input.deliverySeq > lane.nextDeliverySeq - 1) return recordError('ACK_OVER_ACK', …)` — **오늘 이미 `deliverySeq` 에만 의존하며 바이트를 보지 않는다.** AC-6 원문(`docs/spec/30.buildergate-stability.srs.md:3678`)도 바이트 기반 구분을 요구하지 않고 *"client 가 보낸 byte count 를 신뢰해서는 안 된다"* 고만 한다(실제로 `:830` 의 `clientBytes` 는 받기만 하고 어디서도 읽지 않는다). **즉 floor 가 막는다던 열화는 본문-only 의 귀결이 아니라 기존 설계다.**<br>**정정된 사유**: floor 1 은 **본문 0 delivery 가 크레딧·큐 예산을 전혀 쓰지 않고 lane 을 점유하는 상태를 막는다.** 프롤로그-only 프레임을 무제한 밀어 넣어도 `:701`/`:758` 이 delivery 수를 세게 되므로, 원장이 **"바이트 0 = 무료" 라는 구멍**을 갖지 않는다. floor 1 은 **codec 무관**이므로 인코딩 불변(§3.1-B)을 깨지 않는다 |

⚠️ **이 세 줄(도메인 · 전환 시점 · floor)은 `IR-BGSTAB-001` AC 문면에 들어간다.** AC 는 사후 편집 불가(`04:18-31`, `04:141`)다.

##### S0 저작에 대한 직접 지시

1. **`IR-BGSTAB-001` AC 에 "delivery 본문(body) 바이트" 를 문면에 박는다** — "payload 바이트" 라 쓰면 `payloadLength`(= 프롤로그 + 본문, `01:51`)와 혼동된다. **`01` 의 `payload` 는 프롤로그를 포함한다.** 이 용어 함정은 되돌릴 수 없는 AC 텍스트에 들어간다
2. **같은 문장에 "codec 과 무관하게" 를 넣는다** (4차 H-1). 바이너리에만 걸리는 것으로 읽히면 §3.1-B 의 결정이 AC 밖으로 새고, `01:728` 기각 근거가 계약 수준에서 사라진다. ⚠️ **그러나 codec 무관 조항에 "프레임" 이라는 말을 쓰면 안 된다** (5차 검증 L-5): **JSON codec 경로에는 프레임이 없고**, 구현 피연산자는 필드명이 문자 그대로 `payload` 인 **`FairTerminalDeliveryInput.payload`**(`wsSendPolicy.ts:499`, 타입 `string`)다 — 지시 1 이 경계한 용어 함정(`01` 의 `payload` = 프롤로그 포함)이 **반대 방향으로** 남는다. 두 함정을 한 문장에서 동시에 막는 문면 예:
   > *"`encodedBytes` 원장은 codec(json/binary)과 무관하게 **delivery 본문 바이트**만 계상한다. delivery 본문이란 **스케줄러 입력이 나르는 payload**(구현 피연산자는 `FairTerminalDeliveryInput.payload` 의 UTF-8 바이트 길이)이며, **JSON 봉투 필드도 바이너리 프레임의 헤더·프롤로그·세그먼트 배열도 포함하지 않는다** — `01` 의 `payloadLength`(프롤로그 포함)와 같지 않다. 본문이 0인 delivery 는 1로 계상한다."*
   > ⚠️ **"터미널 출력 바이트" 라고 쓰지 않는다** (6차 검증 L-3, 직접 확인). 원장이 계상하는 것은 output 만이 아니다 — `FairTerminalDeliveryKind`(`wsSendPolicy.ts:493`)는 `'output' | 'dataGap' | 'checkpoint' | 'readyBarrier' | 'control'` **5종**이고 `fairDeliveryBytes()`(`:598-611`)는 `kind` 를 가리지 않고 전건을 계상한다(호출부 `:757` `const encodedBytes = fairDeliveryBytes(input, deliverySeq);` 는 `kind` 분기 앞에 있다). AC 에 "터미널 출력" 을 박으면 나머지 4종의 회계가 **문면상 미규정**이 되고, AC 는 사후 편집 불가다. **"delivery 입력 payload" 로 중립화한다.**
3. **같은 AC 에 `byteLength` ≠ `encodedBytes` 를 함께 명문화**한다(§4.2). 두 값이 같다고 읽히면 `01:728` 이 사실상 복권된다. ⚠️ **단 어느 쪽이 실효 상한인지를 AC 에 박으면 안 된다** — 배타적 소관("프레임 수 상한은 `byteLength` 도메인 소관", 5차 검증 L-6)도, 우열("실효 상한은 프레임당 바이트가 큰 `byteLength` 쪽이 준다", **6차 검증 H-3**)도 **둘 다 반증 가능하다.** 후자는 **두 예산의 크기가 같다고 가정**한 산수인데 실제로는 서로 다른 설정 키에서 오고(① `perClientOutputQueueMaxBytes` 기본 2,097,152 / ② `serverBufferedHardLimitBytes` 기본 33,554,432, `config.schema.ts:124`·`:123`) `superRefine`(`:127-135`)이 둘의 관계를 제약하지 않는다 — `perClientOutputQueueMaxBytes=1024` · `serverBufferedHardLimitBytes=536870912` 인 **합법 구성에서 ①이 실효 상한이 되어 문면이 거짓**이 된다(§3.1-B 0B 처분 표 3행).<br>**→ AC 문면은 조건절 없는 참인 명제 하나로, 그리고 *도메인 수준*으로 적는다**: *"delivery 수의 상한은 `encodedBytes` 회계 도메인과 와이어 `byteLength` 도메인이 **각각** 준다."* 어느 쪽이 먼저 걸리는지는 **구성 의존이므로 AC 가 아니라 노트(지시 5)에 적는다.** 조건절을 넣어 *"기본 배포 구성에서는 `byteLength` 쪽이 먼저 걸린다"* 로 쓰는 것도 가능하나, **기본값이 바뀌면 낡는 문면**을 사후 편집 불가한 계약에 넣는 것이므로 권장하지 않는다 `[설계결정]`<br>⚠️ **AC 문면에 `serverBufferedHardLimitBytes` 를 *이름으로* 박으면 안 된다** (7차 검증 H-1, 직접 확인). 그 게이트(`WsRouter.ts:6098-6099`)는 **`wsSendMode` 종속**이고 스키마 기본값은 `'direct'`(`config.schema.ts:201`)인데, `:6086-6094` 가 direct 에서 `:6097` 이전에 early return 하므로 **기본 배포에서는 그 키가 상한을 주지 않는다** — 이름을 박은 문면은 그 자리에서 거짓이 된다. direct 모드에서 `byteLength` 도메인 상한을 주는 것은 `:6169`·`:6182` 의 출력 큐 상한(`:6158` `getEffectiveOutputQueueLimit` → `:5761-5763` `perClientOutputQueueMaxBytes`)이다. **도메인 수준으로 적으면 세 `wsSendMode` 값 전부에서 참이고**, 모드 종속은 노트(지시 5)로 분리된다. ⚠️ 같은 이유로 위 §3.1-B 0B 처분 표 3행의 *"기본 배포 구성에서는 ②가 실효 상한(≈645,277 프레임)"* 도 폐기되었다 — **AC 에 옮기지 않는다**
4. **`PERF-BGSTAB-011` 에 "JSON codec 측 `encodedBytes` 재정의 + `creditWindowBytes` 재측정" 을 명시**한다 — 이것이 S5 의 실체다. 재벤치 근거는 `01:732` 가 아니라 §3.1-B 의 도메인 전환 위에서 세운다 (§5 S5-a 말미)
5. **이 절과 §3.1-A 전체를 SRS 노트로 남긴다** (`append_section_note`, `rationale`). 노트는 도구로 갱신 가능하지만 AC 는 아니다(`04:174`) — 기각 사유가 AC 밖에 있어야 나중에 재검토할 수 있다. ⚠️ **노트에 `wsSendMode` 종속을 반드시 포함한다** (7차 검증 H-1): 어느 게이트가 실효 상한인지는 **두 설정 키의 상대 크기**뿐 아니라 **`wsSendMode` 값**(`config.schema.ts:201`, 기본 `'direct'`)에도 달렸다 — `direct` 에서는 `serverBufferedHardLimitBytes` 게이트가 미도달(`WsRouter.ts:6086-6094`), `safe-send-observe` 는 카운트만 올리고 전송(`:6100-6103`), 실제로 닫는 것은 `safe-send-enforce`(`:6105`) 뿐이다. **두 변수 모두 시간에 따라 바뀌므로 AC 가 아니라 노트에 있어야 한다**

**게이트**: **§3.1-A 의 기각 기록 + §3.1-B 의 JSON codec 규정** 없이 S0-b(신규 REQ 4건 저작)에 들어가지 않는다. 둘은 한 결정의 양면이다 — A 만 있고 B 가 없으면 A 의 기각 근거가 성립하지 않는다. §13 층 A 체크리스트에 각각 항목으로 등재했다.

### 3.2 D2–D9 (정본: `05:741-751`)

| # | 결정 사항 | `05` 권고 | 이 계획의 처분 | 층 | 결정 시점 |
|---|---|---|---|:--:|---|
| D2 | 잔여 output 필드의 프레임 배치 | 3안 미정 (`05:744`) | **해소됨** — `01` §1.8 프롤로그가 확정 | A | 완료 |
| D3 | codec × `wsTransportMode` 조합 범위 | `unified` 에서만 바이너리 (`05:745`) | **채택.** `REL-BGSTAB-006` AC-5 준수 | **A** | S0 저작 전 |
| D4 | 골든 벡터 fixture 물리 위치 | 한 곳, 복사 금지 (`05:746`) | §4 S2 | B | S2 착수 전 |
| D5 | **롤백 트리거 4종의 수렴 지점** | **단일 롤백 함수** (`05:747`) | **미결 — S0 에서 확정** | **A** | S0 저작 전 |
| D6 | `--expect-red` RED 증거 처분 | baseline 갱신 vs superseded 종결 (`05:748`) | **미결** (P3 재핀 주체) | B | **P3 범위 파일 변경 커밋 전 · 다음 `--expect-red` 실행 전** 중 먼저 오는 쪽 (§3 상단 주의 — 4차 M-2 정정) |
| D7 | property test 입력 생성기 | 외부 의존성 없이 시드 기반 (`05:749`) | 채택 | B | S2 착수 전 |
| D8 | Playwright CI 러너 OS | `windows-latest` vs 크로스플랫폼 launcher (`05:750`) | **미결** — `start.bat` 은 Windows 전용 (`frontend/playwright.config.ts:34`) | B | §12 CI 도입 시 |
| D9 | **opcode 공간 설계** | 초기 정의 집합 + 예약 구간 (`05:751`) | **미결이면 S2 fault 테스트가 성립 안 함** — 아래 참조 | B | S2 착수 전 |

> **D5 가 왜 중요한가** (`05:648`): *"네 경로가 각자 롤백을 구현하면 세 개만 고쳐지고 하나는 조용히 어긋난다."* 트리거 4종은 설정 핫리로드(`RuntimeConfigStore.ts:1254`) · 클라이언트 디코드 실패 · capability 재협상 실패(P1 digest 불일치 포함) · 구 빌드 재시작(`05:643-646`).

> **D9 가 왜 S2 의 전제인가** (`05:462`): F3 경계 대조군은 *"**정의된 최대 opcode** → 성공. 미정의 최소값 → 실패"* 를 요구한다. 06 의 "잘못된 opcode" fault 테스트는 **시험할 최대값이 정의되어 있지 않으면 무엇을 재는지 알 수 없다.** `01` §1.3 이 `0x01`~`0x07` 사용 / `0x08`~`0x3F` 예약 / `0x00`·`0xFF` 영구 예약을 이미 정의했으므로, D9 는 **`01` 을 그대로 채택**하는 것으로 종결 가능하다.

### 3.3 D10–D12 (이번 검증에서 추가)

| # | 결정 사항 | 상태 |
|---|---|---|
| **D10** | **협상 메시지 이름** — `01` 은 `terminal-binary:*` 계열, `02:594` 는 `terminal-encoding:capability` | **미해결.** S0 에서 이름을 확정하고 SRS 를 SSOT 로 삼는다. **아래 셈법 주의** |
| **D11** | `FR-BGSTAB-017` recovery write gate 가 unified 선행인가 split 선행인가 | `01:1191` 미배정. 이 계획은 **unified 선행**으로 가정(§4 S0.7) |
| **D12** | 설정 키의 **값 집합** — 2값 vs 4값 사다리 | §5 참조. **4값 채택** |

> ⚠️ **D10 셈법 정정** (2차 검증 M-13, 줄번호는 3차 검증 M-6 으로 재확인). **`01:637`** 은 *"신규 메시지 **5종**"* 이라 쓰고 `01:638-690` 에 **인터페이스 5개**를 정의하지만, **distinct `type` 문자열은 4개**다:
>
> | `type` 문자열 | 인터페이스 (`interface` 키워드 줄) |
> |---|---|
> | `'terminal-binary:capability'` | `TerminalBinaryCapabilityOffer`(**`01:641`**, C→S) **와** `TerminalBinaryCapabilityAccepted`(**`01:650`**, S→C) — **재사용** |
> | `'terminal-binary:rejected'` | `TerminalBinaryRejected`(**`01:665`**) |
> | `'terminal-binary:channel-retired'` | `TerminalBinaryChannelRetired`(**`01:678`**) |
> | `'terminal-binary:unknown-channel'` | `TerminalBinaryUnknownChannel`(**`01:685`**) |
>
> **그리고 이것은 `01` 자신의 결함 지적과 모순된다.** **`01:577`** 은 *"`terminal-delivery:capability` 는 **요청과 응답이 같은 `type` 문자열을 공유**하고 필드로만 구분된다(`:443-448` vs `:743-748`) … **버전 협상에는 부적합하다**"* 라 하고 **`01:575`** 에서 *"checkpoint 쪽 관용구를 본뜨고, **delivery 쪽 형태는 본뜨지 않는다**"* `[설계결정]` 를 선언했다. **그런데 신규 스키마가 정확히 같은 구조를 반복한다.**
>
> **[설계결정] D10 은 이름뿐 아니라 이 구조도 함께 결정한다.** 두 안:
> - **(가)** `01` 이 checkpoint 관용구를 본뜬 취지대로 **요청/응답 type 을 분리**한다 (예: `terminal-binary:negotiate` C→S / `terminal-binary:capability` S→C). **`01:572`** 의 checkpoint 행(`terminal-checkpoint:negotiate` → `:capability` → `:rejected`)이 이미 그 형태다
> - **(나)** 공유를 유지하고 `accepted` 필드로 구분한다 — 단 그러면 `01:577` 의 지적을 **명시적으로 철회**하는 근거를 SRS 노트에 남긴다
>
> 어느 쪽이든 **모순을 표면화하지 않은 채로 S0 저작에 들어가면 안 된다.**

### 3.4 사용자 결정 필요 — **`04` 정본 4건 + 이 계획이 추가한 2건**

이전 판 §8 은 이 중 일부만 옮겼고 **Q2 를 이미 결정된 것처럼 서술**했다.

⚠️ **출처 정정** (2차 검증 M-9, 직접 확인): **`04` §7 "열린 질문 (사용자 결정 필요)" 은 `04:595` 에서 시작해 `04:597-600` 에 정확히 4항목**이며 Q1~Q4 와 1:1 대응한다. **Q5·Q6 은 `04` 에 없다** — 이 계획이 추가한 것이다. 이전 판은 6행 표에 `04:597-600` 하나를 귀속시켜 출처를 뭉갰다.

| # | 질문 | 출처 | 미결 시 결과 |
|---|---|---|---|
| Q1 | §4 수동 패치 5건을 승인하는가 | **`04:597`** | 미승인 시 신규 REQ 4건이 scope 로 안 덮인다 (SRS-MD §8.3 위반) |
| **Q2** | **`wsTransportMode` 와 별개인 `realtime.terminalWireFormat` 키 신설에 동의하는가** | **`04:598`** | **거부 시: `FR-BGSTAB-001` AC-3 + `FR-BGSTAB-008` AC-5 실제 supersede → stable REQ 2건 폐기 + 검증 증거 13건 재수집.** 이전 판 §2.1 은 이를 확정 사항처럼 적었다 — **미결 질문이다** |
| Q3 | 신규 REQ 4건 분할에 동의하는가 | **`04:599`** | 줄이면 Verification Method 혼재(§29.1), 늘리면 표면당 1개 위반 |
| Q4 | `PERF-BGSTAB-010` Status 를 `in_progress` 유지 | **`04:600`** | 대안은 `blocked` |
| **Q5** | GitHub 이슈 9건 갱신 (외부 쓰기) | **이 계획이 추가** — `04` §7 에 없음 | 승인 필요 |
| **Q6** | `docs/issues/` 물리 삭제 여부 | **이 계획이 추가** — `04` §7 에 없음 | git 미추적 → 삭제 시 복구 불가 |

> Q5·Q6 을 유지하는 이유: 둘 다 **외부·비가역 쓰기**라 사용자 승인 없이 수행할 수 없다. 다만 **`04` 가 요구한 것이 아니라 이 계획의 판단**이므로 `[설계결정]` 으로 표기한다.

### 3.5 결정 확정 — 2026-08-18

프로젝트 오너가 **"권장 결정을 따른다 + 나머지는 모두 승인"** 으로 지시했다. 이로써 §3 층 A 게이트는 **전건 해소**되었고, 아래가 그 SSOT 다. 이후 절의 "미결" 표기는 이 절이 우선한다.

#### 사용자 결정 (Q1~Q6)

| # | 결정 | 근거 |
|---|---|---|
| Q1 | **승인** — §8 수동 SRS-MD 패치 5건 진행 | 미승인 시 신규 REQ 4건이 어느 scope 에도 안 덮여 SRS-MD §8.3 위반 |
| Q2 | **승인** — `wsTransportMode` 와 **직교하는** `realtime.terminalWireFormat` 키 신설 | 거부 시 stable REQ 2건 실제 supersede + 검증 증거 13건 재수집. 직교 키가 그 비용을 0 으로 만든다 |
| Q3 | **승인** — 신규 REQ **4건** 분할 유지 | 줄이면 Verification Method 혼재(SRS-MD §29.1), 늘리면 표면당 1개 원칙 위반 |
| Q4 | **`in_progress` 유지** — `PERF-BGSTAB-010` | `blocked` 로 내리면 S5 재벤치가 그 REQ 밖에서 진행되어 증거 귀속이 끊긴다 |
| Q5 | **승인** — GitHub 이슈 9건 갱신 (외부 쓰기) | §3.4 가 요구한 명시 승인. **읽기 전용 조사와 달리 되돌리기 어려우므로 코멘트 우선·본문 최소 변경** |
| Q6 | **삭제하지 않음** (권장안) | `docs/issues/` 는 **git 미추적** → 삭제 시 복구 불가. 조항은 이미 무력화됐고 프레임 계약·롤백 요건·하네스 함정 등 잔여 가치가 있다 |

#### 설계 결정 (D1~D12)

| # | 확정 | 비고 |
|---|---|---|
| D1 | §3.1 + §3.1-A(기각 기록) + §3.1-B(JSON codec 규정) 채택 | 세 절이 한 결정의 세 면. S0-b 게이트 |
| D2 | 해소됨 — `01` §1.8 프롤로그 | — |
| D3 | **`unified` 에서만 바이너리** | `REL-BGSTAB-006` AC-5 준수. split 은 별도 판단 |
| D4 | 골든 벡터 **한 곳, 복사 금지** | 위치는 S2 에서 확정 |
| D5 | **단일 롤백 함수로 수렴** (`05:747` 권고) | 트리거 4종(설정 핫리로드 · 디코드 실패 · capability 재협상 실패 · 구 빌드 재시작)이 **모두 그 함수를 호출**한다. `05:648` — *"네 경로가 각자 구현하면 세 개만 고쳐지고 하나는 조용히 어긋난다"* |
| D6 | **baseline 갱신** — P3 재핀 주체는 **S3 담당자** | superseded 종결은 `--expect-red` 증거를 영구히 잃는다. 마감은 §3.2 표대로 |
| D7 | 외부 의존성 없이 **시드 기반** 생성기 | — |
| D8 | **`windows-latest`** | `start.bat` 이 Windows 전용(`frontend/playwright.config.ts:34`). 크로스플랫폼 launcher 는 별도 작업으로 분리 |
| D9 | **`01` §1.3 을 그대로 채택** | `0x01`~`0x07` 사용 / `0x08`~`0x3F` 예약 / `0x00`·`0xFF` 영구 예약. 이로써 F3 경계 대조군의 "정의된 최대 opcode" = **`0x07`**, "미정의 최소값" = **`0x08`** 로 확정되어 S2 fault 테스트가 성립한다 |
| D10 | **(가)안 — 요청/응답 `type` 분리**, 이름은 `terminal-binary:*` 계열 | `terminal-binary:negotiate`(C→S) / `terminal-binary:capability`(S→C) / `:rejected` / `:channel-retired` / `:unknown-channel` = **distinct type 5개**. `01:575` `[설계결정]`(*"checkpoint 관용구를 본뜨고 delivery 형태는 본뜨지 않는다"*)과 `01:577` 의 결함 지적을 **둘 다 만족**한다 — (나)안은 `01:577` 을 철회해야 하므로 기각. `02:594` 의 `terminal-encoding:capability` 도 기각(계열 통일) |
| D11 | **unified 선행** — `FR-BGSTAB-017` recovery write gate 를 S0.7 에 배치 | `01:1191` 미배정을 이 계획이 확정 |
| D12 | **4값 사다리** `json \| binary-shadow \| binary-optin \| binary` | 2값은 `binary-shadow` 단계를 삭제한다 |

**D10 의 셈법 귀결**: (가)안 채택으로 distinct `type` 이 **4개 → 5개**가 되어 `01:637` 의 *"신규 메시지 5종"* 과 인터페이스 수(5)와 type 수(5)가 **처음으로 일치**한다. §6 의 협상 메시지 표와 S0-b 의 `IR-BGSTAB-001` AC 저작이 이 이름을 SSOT 로 쓴다.

---

## 4. 확정 설계 결정

### 4.1 설정 키 — `realtime.terminalWireFormat`, **4값 사다리** (개정)

이전 판은 `'json' | 'binary'` 2값으로 확정하면서 `05` 의 **3단계 사다리 선례 논증을 통째로 삭제**했다. 복원한다.

`05:539` — *"기존 저장소에 3단계 사다리 선례가 있다 … **새 패턴을 만들지 말고 이 사다리를 따른다**."* 선례는 직접 확인했다: `server/src/schemas/config.schema.ts:201` `wsSendMode: z.enum(['direct','safe-send-observe','safe-send-enforce'])`, `:202` `frontendRuntimeResidency: z.enum(['legacy','bounded','off'])`, `:56` `wsTransportMode: z.enum(['unified','split-shadow','split'])`.

`05:545` 가 제안한 값 집합을 채택하되 **이름은 SRS SSOT 인 `terminalWireFormat`** 을 쓴다 (`05` 는 `wsFrameCodec` 을 제안했다 — 이름 충돌은 여기서 종결).

```ts
// server/src/schemas/config.schema.ts  realtimeSchema (:55-57) 확장
terminalWireFormat: z.enum(['json', 'binary-shadow', 'binary-optin', 'binary']).default('json'),
```

**이 enum 이 곧 마이그레이션 사다리다.** 값 하나가 §5 의 단계 하나에 대응한다.

| 값 | 단계 | 정본 |
|---|---|---|
| `json` | 초기·롤백 목적지 | — |
| `binary-shadow` | 양쪽 인코딩 계산 · **JSON 만 송신** · 의미 동등 diff 계수 | `05:554-562` |
| `binary-optin` | 선언한 클라이언트에만 바이너리 | `05:566-574` |
| `binary` | 기본 클라이언트가 선언 | `05:576-584` |

`05:562` — `binary-shadow` 는 *"사용자에게 노출되는 동작 변화가 없다. **가장 안전한 단계이므로 여기서 최대한 오래 머문다**"*. 이전 판의 S4→S5→S6 는 shadow 와 opt-in 을 **둘 다 건너뛴다.**

⚠️ **`.strict()` 함정** (`05:548`, 직접 확인): `realtimeSchema` 는 `config.schema.ts:57` 에서 `.strict()` 다. 즉 **구버전 서버 + 신 필드를 담은 `config.json5` = 하드 거부**. 다만 `defaultObject()`(`:52-53`)가 섹션 부재를 `{}` 로 치환하므로 **필드를 추가하는 방향은 안전하다. 문제는 되돌리는 방향뿐이다** — 이것이 §5 단계 3 의 롤백 위험이며 D5 의 트리거 4번(`05:646`)이다.

**⚠️ S0 SRS 저작에 대한 직접 귀결**: `04:231` 의 `IR-BGSTAB-001` AC-7 초안은 `realtime.terminalWireFormat`(`json` | `binary`) **2값**으로 쓰여 있다. 이대로 저작하면 **SRS 가 사다리를 잠근다** (그리고 AC 텍스트는 speckiwi 로 못 고친다 — `04:18-31`). S0 은 반드시 **4값으로 저작**한다. D12.

**설정만으로 켜지 않는다.** fair scheduler 와 동일하게 **capability 협상으로 활성화**한다(`02:481`, 선례 `WsRouter.ts:1931-1968`). 설정은 서버가 협상에 응할 수 있는지만 정한다(kill switch).

**`wsTransportMode` enum 을 넓히지 않는다.** 소켓 토폴로지와 와이어 인코딩은 직교 축이다(`02:474-479`, `04:120`). 근거와 잔여 충돌은 §2.2 · §3.4 Q2 참조.

### 4.2 회계 단위 — **두 값으로 분리** (§3.1 D1)

- `byteLength` = **WS 메시지 전체 바이트 = Σ 프레임** (아래 배치 정정 참조). `bufferedAmount` 와 도메인 일치
- `encodedBytes` (ACK credit) = **본문(body) 바이트만.** 헤더·프롤로그·세그먼트 배열을 제외한다 — `05:204` 의 A 안이 요구하는 "인코딩 불변" 은 프롤로그까지 빼야 성립한다(프롤로그 크기가 opcode 별로 다르므로). **이 결론이 `01:728`·`02:243` 을 기각한 결과라는 사실은 §3.1-A 가, 그 기각이 성립하려면 JSON codec 도 같은 도메인이어야 한다는 사실은 §3.1-B 가 보유한다** — 두 절을 읽지 않고 이 줄만 인용하지 않는다. ⚠️ **`encodedBytes` 는 delivery 단위 필드**다(`wsSendPolicy.ts:510`) — 아래 층위 주의 참조

⚠️ **`byteLength` 배치 정정 — 프레임 1개 식을 그대로 쓰면 안 된다** (3차 검증-B M-1). 이전 판은

```
byteLength = 28 + prologueBytes + 16 × segmentCount + bodyBytes      // 프레임 1개
```

를 *"와이어 전체 — §4 S2-b 의 P2 와 같은 식"* 이라 적었다. **P2 자체는 옳다** — `encode(m)` 은 **단일 프레임**의 property 이므로(§4 S2-b). 그러나 **`byteLength` 는 프레임 단위가 아니라 WS 메시지 단위**다:

- 소비자는 `WsRouter.ts:6098` `const projectedBufferedAmount = bufferedAmount + message.byteLength;` (직접 확인) — `bufferedAmount` 는 소켓에 쌓인 **WS 메시지** 바이트다
- 이 계획은 batching 을 채택했다 — §4.5 표: *"batching = 1 WS 메시지 = **N개 완결 프레임**"*(`01:459`), 배치 상한은 `bulkSliceBytes` 에서 파생(§5 S5-a #3, `01:1401`)
- **`01` 의 배치 조립기가 이미 그렇게 쓴다**: `01:1429` `byteLength: out.length,` — `out` 은 `01:1402` 에서 배치마다 새로 만드는 `GrowableBuffer` 이고 `01:1411-1421` 루프가 프레임 N개를 거기에 이어 쓴다. 즉 **`out.length` = Σ(프레임 길이)** 다. `01:1429` 의 주석도 *"ACK/백프레셔 도메인"* 이라 명시한다
- **`01:728` 도 같은 말을 한다** — *"배치면 배치 전체 길이다"*. §3.1-A 가 `01:728` 을 기각한 것은 **`encodedBytes` 에 대해서만**이고, **배치 규정은 `byteLength` 에서 그대로 채택**한다

**확정식**:

```
// WS 메시지 단위 — bufferedAmount 와 같은 층위
byteLength(배치) = Σ_{f ∈ 배치} ( 28 + prologueBytes(f) + 16 × segmentCount(f) + bodyBytes(f) )
                 = out.length                                 // 01:1429 와 동일

// delivery 단위 — ACK credit 원장의 한 행
encodedBytes(d) = max( bodyBytes(d), 1 )                       // 본문만. 헤더·프롤로그·세그먼트 제외
                                                               // floor 1 의 사유는 §3.1-B
```

⚠️ **두 식의 층위가 다르다 — Σ 로 나란히 적지 않는다** (4차 검증 L-5). 이전 판은 두 번째 줄을 `encodedBytes = Σ_{f ∈ 배치} bodyBytes(f)` 로 적어 **`byteLength` 와 같은 층위(배치 단위)로 읽히게** 했다. 그러나 **`encodedBytes` 는 `FairTerminalDelivery` 의 delivery 단위 필드**(`wsSendPolicy.ts:510`, §3.1 도 그렇게 인용)이고, 배치 합은 그 필드가 아니라 **누적 ACK 정산의 총액**이다 — 실제로 `FairTerminalDeliveryScheduler.test.ts:469` 도 `const expectedBytes = firstWireBytes + secondWireBytes;` 로 **두 delivery 를 더한 별도 값**으로 다룬다. ⚠️ **그 값을 쓰는 곳은 `:478` 하나가 아니라 둘이다** (5차 검증 L-1, 직접 확인): `:478` `assert.deepEqual(ack, { accepted: true, creditedBytes: expectedBytes }, signature)` 와 **`:479` `assert.equal(scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes, expectedBytes, signature)`** — **두 단정이 서로 다른 값을 보고 있는데 우연히 같다**(아래 참조). §7 항목 1 은 `:478`·`:479` 를 정확히 구분하는데 이 절만 `:478` 로 좁혀 문서 안에서 어긋나 있었다. **이것이 정확히 §3.1-A 지시 3 이 경고한 오독 경로**다 — 두 값이 같은 층위로 읽히면 `01:728`(배치 전체 길이)이 사실상 복권된다.

**정산 값이 필요하면 이름을 달리한다 — 그리고 둘은 같은 값이 아니다** (5차 검증 M-3 정정, 직접 확인):

```
// ACK 1회가 반환하는 값 — "직전 ACK 이후 델타" 다. 누적 총액이 아니다.
creditedBytes(ACK) = Σ_{ lane.lastAcknowledgedSeq < d ≤ ack.deliverySeq } encodedBytes(d)
                     // wsSendPolicy.ts:839  lane.sent.filter(d => d.deliverySeq > lane.lastAcknowledgedSeq
                     //                                        && d.deliverySeq <= input.deliverySeq)
                     // wsSendPolicy.ts:840  .reduce((total, d) => total + d.encodedBytes, 0)
                     // 반환은 :845 { accepted: true, creditedBytes }        → 테스트 :478 이 보는 값

// 누적 총액 — lane 원장에 순증한다.
lane.creditBytes += creditedBytes(ACK)                          // wsSendPolicy.ts:843 → 테스트 :479 가 보는 값
```

⚠️ **이전 판의 `creditedBytes(ACK) = Σ_{d ≤ ack.deliverySeq} encodedBytes(d)` 는 누적 총액 식이며, 그대로 구현하면 두 번째 ACK 부터 크레딧이 중복 계상된다** — `:844` `lane.socketQueuedBytes = Math.max(0, lane.socketQueuedBytes - creditedBytes)` 가 과다 차감되어 백프레셔가 조기에 풀린다.

⚠️ **테스트가 이 오류를 못 잡는다.** `FairTerminalDeliveryScheduler.test.ts:472-479` 는 **새 lane 에서 ACK 를 한 번만** 보내므로 `lane.lastAcknowledgedSeq === 0` 이고, 그때는 델타와 누적 총액이 **우연히 일치**해 `:478` 과 `:479` 가 같은 `expectedBytes` 로 통과한다. **§S5-a0 에서 이 단정을 손볼 때 두 번째 ACK(seq3)를 추가해 두 값을 갈라 놓는다** — 그러지 않으면 도메인 전환 뒤에도 같은 사각지대가 남는다.

배치 크기가 1 이면 첫 줄이 프레임 1개 식으로 축약된다 — **P2(§4 S2-b)는 그 축약된 경우를 단정하는 property 이므로 수정 불필요**하다. **배치 식을 단정하는 property 는 별도로 세운다** (S2-b P4 의 연접 스트림 벡터를 그대로 재사용).

⚠️ **"백프레셔 25개 지점 무수정" 은 출처가 없다.** 어느 연구 문서에도 그 수가 없다. 직접 확인한 사실:

- `bufferedAmount` 는 `WsRouter.ts` 에 **9회** (`:6083`, `:6084`, `:6098`, `:6213`, `:6214`, `:6219`, `:6223`, `:6573`, `:6574`)
- `02:252` 가 "변경 불필요" 로 열거한 바이트 회계 지점은 그보다 많지만 **정확한 수는 `02` 가 세지 않았다**
- **두 번째 회계 지점**은 `wsSendPolicy.ts:598-611` `fairDeliveryBytes()` — 회계 목적으로 `createWsTransportMessage(...).byteLength` 를 **재호출**한다 (직접 확인). ⚠️ **이것이 오늘의 `encodedBytes` 산출식이며 도메인은 JSON 봉투 전체다** — 위 확정식과 어긋나므로 **무수정 대상이 아니라 §S5-a0 의 변경 대상**이다 (§3.1-B, 4차 검증 H-1)

**클라이언트는 오히려 반대다**: **산수와 결론은 `03:396`** — *"청크 512개로 4 MiB 를 채우려면 **청크당 평균 8,192 바이트**가 필요하다. 즉 평균 프레임이 **8 KiB** 보다 작아지는 순간 바이트 예산이 아니라 **청크 예산이 먼저 터진다**"* (기본값 출처는 `03:394`, `inputReliabilityMode.ts:70-71` = 바이트 4,194,304 / 청크 512). **`03:777` 은 그 결과만 담은 변경 지점 표의 한 행**이다 (2차 검증 L-17 — 이전 판은 8 KiB 산수를 `:777` 에 귀속시켰다). → `chunk-cap-exceeded`(`WebSocketContext.tsx:477`) 조기 발생. 위험 **높음**. `03:404` 의 `[설계결정]` — **청크 회계 단위를 프레임이 아니라 "스케줄러 큐 원소"로 유지**한다.

### 4.3 payload 는 **판별 가능한 유니온**이어야 한다 — 판별자는 `codec` (§5 S4-a 와 통일)

⚠️ **이전 판은 이 절에서 `encoding: 'json' | 'binary'` **필수 필드**(`02:217`)를 확정 결정으로 두고, 같은 문서 §5 S4-a 에서는 *"`01:810-835` 가 `02:217` 을 대체한다"* 며 `encoding` 없는 `WirePayload`(판별자 `codec`)를 채택했다. 두 절이 서로 다른 타입을 지시했다** (2차 검증 M-4). **`01` 안으로 통일한다.**

**확정 형태** (정본 `01:810-822`, 직접 확인):

```ts
type WirePayload =
  | { codec: 'json';   text: string }
  | { codec: 'binary'; bytes: Uint8Array; codecEpoch: number };

interface WsTransportMessage {
  payload: WirePayload;
  byteLength: number;   // codec 에 따라 text 의 utf8 길이 또는 bytes.byteLength
}
```

**`02:217`(안 (b), `payload: string | Uint8Array` + `encoding` 필수)의 *동기*는 그대로 유효하고, `01` 안이 그 동기를 더 강하게 만족한다.**

| 요구 | `02:217` (`encoding` 평면 필드) | **`01:810` (`WirePayload` 유니온)** |
|---|---|---|
| 어느 메시지가 바이너리인지 타입으로 안다 | ✅ | ✅ |
| `Buffer.byteLength` 호출부가 분기를 **강제**당한다 | ✅ | ✅ |
| **"JSON 소켓에 바이너리를 보낸다" 가 표현 불가** | ❌ — `{payload: bytes, encoding:'json'}` 이 타입상 합법 | ✅ `01:835` — `{codec:'binary'}` 는 `text` 필드가 없어 `ws.send(text)` 경로가 **컴파일되지 않는다**(`01:1064`) |
| **S6 롤백 보장**(`codecEpoch` 게이트, `WsRouter.ts:6249`) | ❌ 자리가 없다 | ✅ `codecEpoch` 가 바이너리 변형에만 붙는다 (`01:1066-1081`) |

⚠️ **"필수 필드면 모든 픽스처가 컴파일 에러로 드러난다"(`02:220`)는 서버에만 성립한다** (2차 검증 M-8, 직접 확인):

| 대상 | tsconfig | 결과 |
|---|---|---|
| `server/src/**` (테스트 포함) | `server/tsconfig.json:17` `"include": ["src/**/*"]` | ✅ **`*.test.ts` 도 컴파일 대상.** 픽스처가 컴파일 에러로 드러난다 |
| `frontend/tests/**` | `frontend/tsconfig.app.json:27` `"include": ["src"]` **뿐** | ❌ **`tsc -b` 대상이 아니다.** 게다가 실행이 `node --experimental-strip-types` 라 **타입 검사 없이** 돈다 → **컴파일 에러가 영원히 안 난다** |

**[설계결정] 프론트엔드 픽스처는 컴파일러가 아니라 다른 수단으로 잡는다.** 세 가지 중 하나 이상:
1. `frontend/tests` 를 포함하는 별도 tsconfig 프로젝트를 만들고 §12 Tier 0 에 `tsc --noEmit -p <그 파일>` 을 추가
2. 디코더/스케줄러 **진입점에 런타임 shape 단언**을 두어 잘못된 픽스처가 즉시 throw 하게 한다
3. 골든 벡터(§4 S2-a)를 프론트가 **반드시 소비**하게 해 픽스처를 한 곳으로 모은다

⚠️ **vacuity 지점은 1곳이 아니라 5곳** (정본 `02:172-175`, `02:260`, `02:540` — 위치는 전부 직접 재확인):

| 위치 | 무엇이 무의미해지나 |
|---|---|
| **`WsRouter.ts:1405`** (비교문) → **`:1409`**(리터럴 `'tampered-queued-message-byte-length'`) | `:1405` `Buffer.byteLength(message.payload,'utf8') !== message.byteLength` — TypedArray 는 `byteLength` 를 반환해 **일치하지만 검사가 무의미**. **거부 사유 문자열이 있는 줄은 `:1409` 다**(2차 검증 L-1) |
| **`WsRouter.ts:1383`, `:1413`** | canary admission preview/admit 의 incoming 바이트 계산. **`02:173` 의 *"두 피연산자가 같은 출처가 되어 대조 능력이 사라진다"* 는 이 두 줄에 대한 서술이다.** ⚠️ **필드 이름 정정** (3차 검증-B L-4, 전수 grep): **`computedIncomingBytes` 는 `:1370`(타입 선언)·`:1383`·`:1421` 세 곳뿐**이고 **`:1413` 은 `const incomingBytes = Buffer.byteLength(input.incomingMessage.payload, 'utf8');`** 다 — 이름이 다른 지역 변수이며 그 값이 `:1421` 에서 `computedIncomingBytes: incomingBytes` 로 흘러든다. **vacuous 화 대상이라는 실질은 옳고 이름만 틀렸다**(`02:173` 에서 상속). 런타임 shape 단언은 `:1383` 과 `:1413` **두 계산 지점 모두**에 붙인다 |
| **`WsRouter.ts:1421`**(`computedIncomingBytes: incomingBytes,`) / **`:1425`**(`if (incomingBytes !== input.incomingMessage.byteLength)`) → **`:1426`** 사유 `'tampered-message-byte-length'` | 같은 vacuity. ⚠️ **이전 판은 `:1425` 를 `computedIncomingBytes` 로 적고 `02:173` 인용문을 붙였는데 둘 다 틀렸다** — 필드는 `:1421`, 인용문의 주어는 `:1383`/`:1413` 이다. `:1425` 를 열거한 것은 `02:260`·`02:540` 이고 **`02` 자체가 §2.3 목록과 §3.3/§8.2 목록이 어긋나 있다**(전자는 1383/1405/1413/1474, 후자는 1383/1405/1413/1425). 이 표가 합집합이며 그 사실을 여기 명시한다 (2차 검증 M-3) |
| **`WsRouter.ts:1474`** | `{...input.incomingMessage}` 얕은 복사 → Uint8Array **aliasing**. *"프레임 버퍼 재사용 금지를 명시해야 함"* (`02:175`) |
| **`tools/wave3/terminal-resource-policy-differential.ts:120`, `:211`** | `Buffer.from(message.payload)` — **인코딩 인자 없음** → differential 증거 해시가 조용히 달라진다. 위험 **높음** (`02:174`, `02:544`) |

⚠️ **버퍼 재사용 위험의 출처 정정** (2차 검증 L-11, 직접 확인): 이전 판은 `WsRouter.ts:1474` 행에 *"`01:1387-1395` 의 공유 `GrowableBuffer` 와 직결"* 이라 적었으나, **`01` 은 버퍼를 공유하지 않는다** — `01:1402` 가 `flushBatch` 안에서 `const out = new GrowableBuffer()` 를 **배치마다 새로** 만들고, `:1387-1395` 는 그 `out` 에 헤더 28B 를 쓰는 인코더 본문이다. **재사용 위험은 `01` 의 설계가 아니라 `02:175` 의 경고**다. 따라서 이 항목의 처방은 *"`01` 을 조심"* 이 아니라 **"인코더 출력 버퍼를 재사용하는 최적화를 도입하지 말 것, 도입하려면 `:1474` 의 얕은 복사부터 고칠 것"** 이다.

**[설계결정]** 위 5개 전부에 **런타임 shape 단언**을 붙여 vacuous 화를 red 로 드러낸다. 메모리 `unchecked_private_field_casts_go_vacuous` 의 직접 적용이다.

### 4.4 클라이언트 진입점 — `enqueue` 확장이 아니라 `enqueueBytes` 신설

`TextEncoder.encode(Uint8Array)` 는 던지지 않고 **암묵적 `String()` 변환**을 거쳐 `"27,91,49"` 같은 문자열을 인코딩한다(`03:236`). `enqueue` 의 유일한 가드는 `data.length === 0`(`:1363`)인데 `Uint8Array` 에도 `.length` 가 있어 통과한다.

⚠️ **확증 등급 정정** (2차 검증 M-11): 이전 판은 이 문장에 *"실행 확인"* 을 붙였으나 **`03:236` 에는 마커도 실행 증거도 없다.** `03` 전체에서 실행 증거가 있는 곳은 **`03:626`**(*"이 조사에서 실제로 실행해 확인했다"* — §10.1 벤치마크 RED) **한 곳뿐**이다. 동작 자체는 `TextEncoder.encode(usvString)` 의 인자 강제변환 규칙상 참이지만, **이 계획이 실행해 확인한 것은 아니다** → `[추정]`. **S4 의 RED 테스트 11건 중 "`enqueue` 에 `Uint8Array` 거부"(`03:708`)가 이것을 실측으로 승격시킨다.**

⚠️ **"변환 장벽은 정확히 한 곳" 은 틀렸다.** `03:41` 자신이 *"정확히 한 곳"* 이라 쓰면서 **두 곳을 인용**한다. **`encode` 호출 지점은 세 곳**이다 — 단 `03` 의 분류는 이 계획과 다르며, 그 차이가 처방을 가른다 (2차 검증 M-12):

| 위치 | 진입점 | **`03` 의 분류** | **`03` 의 처방** | S4 의 처분 |
|---|---|---|---|---|
| `terminalOutputScheduler.ts:1367` | `enqueue` (`:1362`) | **변환 장벽** (`03` 지도 12번) | bytes 경로는 우회, `:1407-1415` 큐 push 로 직행 (`03:749`) | `enqueueBytes` 신설 |
| `terminalOutputScheduler.ts:1460` | `enqueueLegacy` (`:1456`) | *"동일 인코딩"* (지도 13번) — **legacy 경로** | 동상 (`03:749`) | `enqueueBytes` 가 legacy 도 덮는다 |
| `terminalOutputScheduler.ts:810` | retry 큐 `defer` 회계 | **회계용** — `03:84` 가 *"나머지 인코딩(5, 8, 10, **14**)은 전부 조건부이거나 회계용"* 이라 명시하고 `:810` 이 그 14번이다 | **`03:750` — *"`:810` 의 encode 를 `.byteLength` 로"*** (변환 장벽 처리가 아니다) | **`.byteLength` 치환.** `enqueueBytes` 대상이 아니다 |

**즉 세 곳을 다 처리하되 `:810` 만 처방이 다르다.** 이전 판은 셋을 뭉뚱그려 "변환 장벽 3곳"이라 불러 `:810` 에 잘못된 처방을 유도했다.

**그리고 단일 `enqueueBytes` 만 신설하면 `enqueueLegacy` 가 방치된다.** 메모리 `checkpoint_delivery_requires_authority_promotion` 이 기록하듯 기본 세션은 legacy 고정이고 debug-capture 승격이 필요하다 — 즉 legacy 경로가 예외가 아니라 **기본**이다. S4 는 세 곳 전부를 처리한다.

### 4.5 coalescing — payload 병합, 단 1단계에서는 제한

현재 구현은 프레임을 잇는 게 아니라 `data` 문자열을 병합 후 JSON 을 재생성한다(`02:280-289`). 따라서 payload 병합이 1:1 대응한다(`02:296`).

⚠️ **이전 판은 coalescing 과 batching 을 혼동했다.** 둘은 다른 메커니즘이다.

| 개념 | 정의 | 정본 | 레코드 프레이밍 |
|---|---|---|---|
| **coalescing** | 인접 output **payload 를 병합**해 1 프레임으로 | `02:289-296` | **불필요.** 현행 JSON 도 경계 없이 `data` 를 병합한다 (`02:289`) |
| **batching** | 1 WS 메시지 = **N개 완결 프레임** | `01:459` | 각 프레임이 `payloadLength` 를 가지므로 **자기서술적** |

즉 "길이 접두 레코드 프레이밍" 은 **batching 소속**이지 coalescing 의 전제조건이 아니다. `01:465` 가 `payloadLength` 를 채택한 세 번째 근거가 정확히 이것이다.

⚠️ **`sourceSegments` 금지 사유가 낡았다.** `02:309` 는 **21B 초안** 기준으로 *"프레임 초안에 자리가 없다"* 고 했다. **28B 확정안에는 자리가 있다** — `01:496-508` 이 OUTPUT 프롤로그에 `segmentCount`(uint16, off 22)와 **세그먼트당 16B 배열**(`byteStart`/`byteEnd`/`screenSeqDelta`/`authorityRevisionDelta`/`chunkIdDelta`)을 정의했다.

**[설계결정]** 1단계에서는 여전히 `sourceSegments` 보유 output 의 coalesce 를 금지한다 — 단 사유는 **"자리가 없어서"가 아니라 "오프셋 재배치(`wsSendPolicy.ts:251-258`, `:297-319`)와 delta 표현 범위 검사(`01:508`)를 동시에 도입하지 않기 위해"** 다. `02:315` 의 (a) 안. 2단계에서 프롤로그 세그먼트 배열로 해제한다.

---

## 5. 단계별 계획

각 단계는 **실패 테스트 선행**이다. 게이트 폐기는 TDD 면제가 아니다 (`00:77`).

**단계 ↔ 사다리 값 대응**

```
S-1 ─ S0 ─ S0.5 ─ S0.7 ─ S1 ─ S2 ─ S2.5 ─ S3 ─ S4 ────── S5 ───────── S6
                                                  binary-shadow  binary-optin  binary
```

### 스위트 지형 (모든 단계의 커맨드가 이 표를 참조한다)

저장소에는 **disjoint 러너 6개**가 있고 **루트에 `test` 스크립트가 없다**(`05:665`, CLAUDE.md). `05:352-354` 가 "각 단계마다 어느 러너가 그 파일을 실제로 도는지 명시" 를 설계 원칙으로 삼은 이유다.

| 스위트 | 대상 | 커맨드 (cwd) |
|---|---|---|
| A. 모놀리식 러너 | `server/src/test-runner.ts` — **`*.test.ts` 를 디스커버리하지 않는다** | `npx tsx src/test-runner.ts` (`server/`) |
| B. node:test (server) | `server/src/**/*.test.ts` **37개** — 분포는 **benchmarks 8 / services 16 / ws 7 / utils 3 / routes 1 / schemas 1 / types 1** (직접 확인). ⚠️ **`src/ws/` 는 7개뿐이다** | `npx tsx --test src/<경로>.test.ts` (`server/`) — **파일별** |
| C. frontend node:test | `frontend/tests/unit/` 56 + `tests/benchmarks/` 2 + `tests/e2e/wave1-characterization-artifacts.test.ts` — **Playwright 미수집** | `node --experimental-strip-types --test <파일>` (`frontend/`) |
| D. Playwright | `frontend/tests/e2e/*.spec.ts` 30개 | `npx playwright test <spec> --project "Desktop Chrome"` (`frontend/`) |
| E. wave3 증거 스크립트 | 5개, **node:test 아님** | `node tools/wave3/<파일>` (루트) |
| F. wave3 closure / wave1 / server tools | node:test | `node --test <파일>` (루트) |

> ⚠️ **`server/src/` 아래 새 `*.test.ts` 는 A 가 돌지 않는다** (`05:354`, 메모리 `buildergate_test_runner_excludes_node_test_files`). 반드시 B 로 파일별 실행하고 §12 CI 에 등록한다.

---

### S-1 — 회귀 기준선 확보 ⚠️ **신설, S0 보다 앞선다**

`05:763-764` — *"§5.3 회귀 전수 커맨드가 현재 상태에서 전부 green 임을 기준선으로 확보. **전환 후 red 를 '우리가 깬 것' 과 '원래 깨져 있던 것' 으로 구분하기 위함.**"*

이것 없이 착수하면 §7 의 기존 결함 5건이 전부 "우리가 깼다" 로 오진된다. 특히 P5 는 **이미 RED** 다(`03:47`, `03:652`).

**절차**: §스위트 지형 A~F 를 전부 실행하고 **파일별 pass/fail 을 기록**한다. red 항목은 사유를 함께 적는다.

**검증 커맨드** — 정본은 `05:378-411` 의 **8개 그룹**이다. 이전 판의 8줄 블록은 그중 **daemon(그룹 5)·wave1·server tools(그룹 8)·wave3 증거 스크립트 3개(그룹 7의 일부)를 누락**했다 (2차 검증 M-6). 전건을 아래에 싣는다.

⚠️ **각 줄은 독립 실행이다.** 이전 판처럼 `cd server` / `cd frontend` 를 연속으로 나열하면 **한 셸에서 순차 실행 시 두 번째 `cd` 부터 실패**한다 (2차 검증 L-21). 아래는 **루트로 되돌아오는 형태**로 쓴다.

```bash
# 그룹 1 — A. 모놀리식 러너 (*.test.ts 미디스커버리)
( cd server && npx tsx src/test-runner.ts )

# 그룹 2 — B. node:test (server) 37개, 파일별
#   ⚠️ 37개는 src/ws/ 아래가 아니다. 디렉터리별 분포(직접 확인):
#      benchmarks 8 / services 16 / ws 7 / utils 3 / routes 1 / schemas 1 / types 1
#   src/ws/ 의 7개:
( cd server && npx tsx --test src/ws/FairTerminalDeliveryScheduler.test.ts )
( cd server && npx tsx --test src/ws/WsRouterCheckpointProtocol.test.ts )
( cd server && npx tsx --test src/ws/WsRouterRestoreMetadata.test.ts )
( cd server && npx tsx --test src/ws/WsRouterSendPriority.test.ts )
( cd server && npx tsx --test src/ws/WsRouterSplitHandshake.test.ts )
( cd server && npx tsx --test src/ws/wsSendPolicyRestoreMetadata.test.ts )
( cd server && npx tsx --test src/ws/wsTransportMode.test.ts )
#   나머지 30개(benchmarks/services/utils/routes/schemas/types)도 같은 형태로 전부 돈다

# 그룹 3 — C. frontend node:test (Playwright 미수집)
( cd frontend && node --experimental-strip-types --test tests/unit/<각 파일> )      # 56개
( cd frontend && node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts )  # P5 — 현재 RED 예상
( cd frontend && node --experimental-strip-types --test tests/benchmarks/terminalNoRenderFixture.test.ts )
( cd frontend && node --experimental-strip-types --test tests/e2e/wave1-characterization-artifacts.test.ts )

# 그룹 4 — D. Playwright
( cd frontend && npx playwright test --project "Desktop Chrome" )

# 그룹 5 — daemon 19개 ⚠️ server build 를 탄다 → P1 게이트를 먼저 통과해야 한다
npm run test:daemon

# 그룹 6 — wave3 closure 22개 (재귀 게이트)
node --test tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs   # 형제 21개 재실행
node --test tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs    # 9개 재실행

# 그룹 7 — wave3 증거 스크립트 5개 (node:test 아님)
node tools/wave3/authority-promotion-evidence.test.mjs        # ⚠️ Playwright E2E 까지 실행 — P3
node tools/wave3/retained-shadow-parity.test.mjs              # P4
node tools/wave3/canary-admission-evidence.test.mjs           # P2
node tools/wave3/fair-scheduler-decision.test.mjs             # 벤치마크 실행 (테스트 아님)
node tools/wave3/terminal-resource-consumer-manifest.test.mjs

# 그룹 8 — wave1 / server tools ⚠️ server tools 는 2개다 (3차 검증-B L-3)
node --test tools/wave1/g1-decision-gate.test.mjs
node --test server/tools/write-fair-scheduler-evidence-bundle.test.mjs
node --test server/tools/ensure-node-pty-windows-hide.test.cjs
```

⚠️ **그룹 8 의 server tools 누락 정정** (3차 검증-B L-3, 직접 확인). 이전 판은 `write-fair-scheduler-evidence-bundle.test.mjs` **1개만** 실어 놓고 §S-1 상단에서 *"전건을 아래에 싣는다"*, §13 체크리스트에서 *"server tools … 빠뜨리지 말 것"* 이라 적어 **자기모순**이었다. `05:408-410` 에서 상속된 누락이다.

`ls server/tools` 결과는 5개 파일이고 그중 `*.test.*` 는 **2개**다:

| 파일 | 러너 | 비고 |
|---|---|---|
| `write-fair-scheduler-evidence-bundle.test.mjs` | node:test | **P1 계열** — evidence bundle 재발행 검증 |
| **`ensure-node-pty-windows-hide.test.cjs`** | node:test (`require('node:test')`, 직접 확인) | **prebuild 패처**(`ensure-node-pty-windows-hide.cjs`)의 멱등성·드리프트 게이트. **server build 파이프라인의 첫 단계**이므로 이것이 red 면 build 를 타는 모든 명령이 깨진다 |

**S-1 기준선에서 이 파일을 빼면**, 전환 중 build 가 깨졌을 때 원인이 P1(provenance) 인지 prebuild 패처인지 구분할 수 없다 — §S-1 의 존재 이유("우리가 깬 것 vs 원래 깨져 있던 것")가 그 지점에서 무력해진다.

⚠️ **주의**
- `authority-promotion-evidence.test.mjs`(E)는 Playwright E2E 까지 돌리고 2222 에 서버가 없으면 `start.bat` 으로 **프로덕션** 서버를 띄운다. `dev.js` 가 떠 있으면 `reuseExistingServer: true`(`frontend/playwright.config.ts:36`) 때문에 dev 번들을 검사한다 (`05:413`)
- 장시간 dev 인스턴스는 E2E 를 오염시킨다 — **spec 배치마다 서버를 새로 띄운다** (`05:415`, 메모리 `long_lived_dev_instance_degrades_e2e`)
- `npm --prefix server test` 는 **build 를 탄다** → P1 이 red 면 테스트 코드와 무관하게 실패한다. 기준선 수집에는 A 를 쓴다

**게이트**: 기준선 문서화 완료. **green 일 필요는 없다** — 알려진 red 를 목록화하는 것이 목적이다.

---

### S0 — SRS 저작 (코드 없음)

wave-5 요구사항이 **0건**이라 런타임 코드가 blocked 다 (`04:63-64`, `05:25`).

#### S0-a. Active Target 전환 (이전 판 누락)

현재 Active Target 은 **`wave-3`** 다 — **`docs/spec/00.index.md:9`** `| Active Target | wave-3 |` (직접 확인). ⚠️ **`:35` 는 §3 Target Map(`:25` 헤딩, `:27` 표 헤더)의 wave-3 행**이지 Active Target 필드가 아니다 (2차 검증 L-16). `wave-5` 는 `planned` 이며 Target Map 에 이미 등록되어 있고 Goal 도 설정되어 있다(`00.index.md:45` §Target: wave-5).

`04:473-477` 의 순서를 그대로 따른다:

```
set_active_target(target="wave-5", dryRun=true)   → 결과 확인
set_active_target(target="wave-5")
get_active_target                                  → "wave-5" 확인
```

`set_target_goal` 은 **호출하지 않는다** — goal 이 이미 있고 본 계획과 일치한다 (`04:478`).

#### S0-b. 신규 REQ 4건

전부 `wave-5` / `planned` / **`evolving`**:

```
IR-BGSTAB-001   와이어 포맷 + capability 협상          (기반)
   └── FR-BGSTAB-024   전 소비자 단일 인코더/디코더 수렴
        └── PERF-BGSTAB-011  encodedBytes 회계 + 증거 번들 재발행
             └── MIG-BGSTAB-004  기본값 전환 + 되돌릴 수 있는 롤백
```

⚠️ **위 4개 ID 는 `[추측]` 이다.** `04:203` — *"ID 는 `add_requirement` 가 자동 할당한다. 아래 ID 는 **예측**이며 수동 지정하지 않는다."* `04:540` 이 수동 편집을 금지한다. 실제 할당값이 다르면 그 값을 쓰고 이 문서를 사후 갱신한다.

**stability 를 반드시 명시한다.** 생략 시 도구가 `draft` 를 적용한다(`04:204`).

⚠️ **이유 정정**: 이전 판은 *"`SRS-W023` 이 +4 되므로"* 라고 했으나, `docs/rule/SRS-MD-Rules-v2.5.0.md:1679` 는 **`SRS-W023` = "Draft requirement in *active or released* target"** 이다 (직접 확인). **wave-5 는 `planned`** 이므로 `SRS-W023` 이 그 4건을 잡을지 불확실하다.

- 지시 자체(stability 명시)는 **여전히 옳다** — CLAUDE.md 상 `draft` 는 구현 착수가 금지된다
- 그러나 **`byCode` 델타 0 게이트가 이 항목에 눈멀었을 수 있다.** wave-5 가 planned 인 동안 draft 가 경고를 내지 않으면 델타가 0 인 채로 draft 가 통과한다
- **보완 게이트**: REQ 생성 직후 `summarize_target(target="wave-5")` 로 `countsByStability: {evolving: 4}` 를 **직접** 확인한다 (`04:579`)

#### S0-c. 필수 저작 내용 (이전 판 누락분)

| 항목 | 근거 | 왜 필수인가 |
|---|---|---|
| `terminalWireFormat` **4값 사다리** | §4.1, `05:545` | `04:231` 초안(2값)대로 쓰면 SRS 가 사다리를 잠근다. AC 는 사후 편집 불가(`04:18-31`) |
| `PERF-BGSTAB-011` AC-7 에서 **커밋 순서 조항 삭제 + "fair-scheduler evidence bundle" 한정어 추가** | §2.1 | 반박된 전제를 stable 계약에 굳히지 않기 위함. **한정어가 없으면 P3·P5 가 반증 사례**가 된다 |
| **S5 재조정 범위 = 정책 키 9개를 *다룬다*, 단 처분이 셋으로 갈린다** — **바이트 5개 재측정 + 비율/문자열 3개 재귀속 + 시간 1개 별도** | §5 S5-a | ⚠️ **4차 M-3 + 5차 M-2 정정. "9개를 재조정한다" 로도, "5 + 4" 로도 쓰면 안 된다.**<br>① *"9개를 재조정"* 은 **충족 불가능한 검증 대상을 stable 계약에 굳힌다** — `visibilityWeight`·`driverWeight` 는 값이 움직일 수 없다(`TerminalResourcePolicy.ts:49-51`·`:53-55` + `config.schema.ts:124-125` 의 하한 1024 보증). 게다가 `PERF-BGSTAB-010` AC-4(`30.*:3676`)는 **7개**만 명시하므로 "9" 는 AC-4 와도 어긋난다<br>② *"5 + 4"* 는 **`ackTimeoutMs` 를 "비율/문자열 4개" 에 넣은 것인데 그것은 비율도 문자열도 아니다** (5차 검증 M-2). 시간 도메인 키이고 §5 S5-a #8 은 *"재측정 범위에는 넣는다 `[추정]`"*, §13 층 B 는 별도 줄로 두어 **세 곳이 서로 달랐다**<br>③ *"5개" 로만* 쓰면 재귀속 대상을 놓친 채 아티팩트가 재발행된다<br>**저작 문면**: *"바이트 도메인 5개(`socketSoftGateBytes`·`bulkSliceBytes`·`smallOutputBypassBytes`·`creditWindowBytes`·`queueMaxBytes`)는 재측정하고, `strategy`·`visibilityWeight`·`driverWeight` 는 재발행된 아티팩트에 **재귀속**하며, `ackTimeoutMs` 는 시간 도메인이므로 값 변화 여부를 재측정 범위에 포함하되 바이트 재측정과 **별도 항목**으로 기록한다."*<br>⚠️ **`bulkSliceBytes` 는 한 키가 두 도메인에 걸쳐 있다**(5차 H-1) — deficit quantum(`wsSendPolicy.ts:706-712`, 대조 `:717`)은 `encodedBytes` 도메인, 배치 상한(`01:1401`, `out.length`)은 와이어 도메인. **AC 문면이 "재측정" 을 한 번으로 읽히게 쓰면 (b) 가 누락된다** — 두 역할을 각각 재측정한다고 적는다 |
| **D1 의 두 도메인 분리 + JSON codec 측 규정** 명문화 | §3.1, **§3.1-B** | `byteLength` ≠ `encodedBytes`. **그리고 `encodedBytes` 본문-only 가 codec 무관이라는 것과 floor 1** — 빠뜨리면 `01:728` 기각 근거가 계약 밖으로 샌다 (4차 H-1). ⚠️ **두 도메인의 *우열*은 AC 에 넣지 않는다** (6차 검증 H-3): *"실효 상한은 `byteLength` 쪽이 준다"* 는 두 예산 크기가 같다는 가정 위에서만 참이고, `perClientOutputQueueMaxBytes=1024` · `serverBufferedHardLimitBytes=536870912` 인 **합법 구성이 반증 사례**다(`config.schema.ts:123`·`:124`, `superRefine` `:127-135` 은 두 키 관계 무제약). 저작 문면은 **"두 도메인이 각각 상한을 준다"** — 상세는 §3.1-B S0 지시 3. ⚠️ **AC 문면에 "터미널 출력 바이트" 도 쓰지 않는다** (6차 L-3): 원장은 `FairTerminalDeliveryKind` **5종**(`wsSendPolicy.ts:493`) 전건을 계상한다 → **"delivery 입력 payload"** 로 중립화 |
| D3 · D5 · D9 확정 | `05:745`, `:747`, `:751` | S2/S6 의 전제 |
| **`FR-BGSTAB-017` 관계** 명시 | `00:93`, `01:1189` | D11 |

#### S0-d. 기존 REQ 노트 6건 ⚠️ 이전 판 누락

`04:509-518` 이 **6건**의 `append_section_note` 를 규정한다. **전부 필수다.**

| # | 대상 | section | 근거 |
|---|---|---|---|
| 23 | `REL-BGSTAB-003` | `rationale` (`mode=append`) | `04:513`. **도구로 원문을 직접 갱신할 수 있는 유일한 항목**(`04:174`) |
| 24 | `PERF-BGSTAB-009` | `implementation_notes` | `04:514` |
| 25 | `PERF-BGSTAB-010` | `research` (`mode=append`) | `04:515` |
| 26 | **`FR-BGSTAB-008`** | `implementation_notes` | `04:516`. **노트 필수 근거는 `04:141`** — *"단, 이 처리는 AC-5 문면과 구현이 어긋난 상태를 남긴다는 점을 정직하게 기록해야 한다 — **그래서 노트가 필수이며 선택이 아니다**"*. ⚠️ 이전 판이 §2.2 에서 인용한 **`04:135` 는 빈 줄**이다 (2차 검증 L-10) |
| 27 | `FR-BGSTAB-007` | `implementation_notes` | `04:517` |
| 28 | `REL-BGSTAB-007` | `implementation_notes` | `04:518` |

**Status·Stability·AC 체크 상태를 건드리는 호출은 하나도 없다** (`04:511`, `04:538`).

#### S0-e. Trace Link — **21개 에지**

`04:499-506` Phase 5: REQ-1 **7개**(Requirement 6 + Doc 1) · REQ-2 **6개** · REQ-3 **4개** · REQ-4 **5개** = **22 호출 / Requirement 에지 21개**. 이전 판 다이어그램은 4노드 직렬 체인만 보여주어 이 21개 에지를 은폐했다.

`relation="supersedes"` 는 **어느 호출에도 등장하지 않는다** (`04:507`).

#### S0-f. 도구 운용 규칙 ⚠️ 이전 판 누락

- **모든 mutation 은 `dryRun: true` 선행**(`04:455`). `add_requirement`·`set_active_target`·`set_target_goal`·`append_section_note` 는 dryRun 지원. **`add_trace_link` 와 `update_status` 는 dryRun 이 없으므로 호출 후 즉시 `git diff` 로 확인**한다
- ⚠️ **`mcp__speckiwi__*` 는 메인 ProjectMaster 체크아웃에 바인딩된다**(`04:457`, 메모리 `speckiwi_mcp_wrong_worktree_binding`). 워크트리 작업 중이면 `npx speckiwi --root <워크트리>` CLI 를 쓴다
- ⚠️ `edit-table-rows` 계열에서 top-level `notes` 가 조용히 무시된 전례가 있다(`04:459`, 메모리 `speckiwi_edit_table_rows_notes_field_silently_ignored`). **모든 mutation 후 `git diff` 확인**
- ⚠️ 공유 워크트리에서 `git add <경로>` 후 `git commit` 은 인덱스 전체를 커밋한다 → **`git commit -- <경로>`** 형태로 쓴다(`04:584`)

**검증 게이트**: `--fail-on-warning` 은 기준선이 이미 실패(`errors:1, warnings:19`, `04:551`)하므로 못 쓴다 → **`byCode` 델타 0** + `summarize_target` 직접 확인(위 S0-b).

**검증 커맨드** (cwd=루트):
```bash
npx speckiwi validate --json          # byCode 델타 0
npx speckiwi summary --target wave-5 --json   # total:4, countsByStability:{evolving:4}
npx speckiwi links check --json       # broken 0
```

**Scope Boundaries 패치 5건은 Q1 승인 후에만** (§8).

---

### S0.5 — republish 리허설 (하드 게이트) ⚠️ **전면 개정**

이전 판은 *"수정하지 않은 트리에서 `publishFairSchedulerAuthorityGeneration` 을 임시 `authorityRoot` 로 발행하고 라이브 generation 과 대조한다"* 고 했다. **이것은 리허설이 아니다** — `05:297` 이 확인했듯 그 함수는 *"현재 테스트에서 **임시 디렉터리 대상으로만** 호출된다"*. 이미 작동하는 경로를 재확인하는 것일 뿐이다.

그리고 `05:731`(U1) — *"실제 `docs/analysis/terminal-fairness-authority/` 대상 호출의 성공 사례를 확인하지 못함. **S0.5 리허설로 확정할 것**"*. 즉 **미확인 지점은 정확히 실제 authority root 대상 발행**이다.

`05:301` 이 처방한 진짜 리허설 (`05:361` 이 단계표에 명시):

| # | 단계 | 확인 |
|---|---|---|
| 1 | 핀 파일(`wsSendPolicy.ts`)에 **no-op 편집** — 공백 한 칸 삽입 | 파일 저장 |
| 2 | **게이트 red 확인** | 아래 커맨드가 실패해야 한다. **실패하지 않으면 게이트가 무의미한 것이므로 그 사실이 먼저 보고 대상** |
| 3 | **republish** — 재측정 → 새 generation 발행 → `current.json` 갱신 | `05:297` — republish 는 "해시 갱신"이 아니라 **재측정**이다 (`createFairSchedulerDecisionArtifact()` 가 벤치마크를 실제 실행) |
| 4 | **green 복구 확인** | 같은 커맨드가 통과 |

**검증 커맨드 (cwd=`server/`)**:
```bash
npx tsx --test src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts
```
보조: `npx tsx --test src/benchmarks/terminalFairnessCharacterization.test.ts` (`:203` 이 `getFairSchedulerBenchmarkSourceDigest() === artifact.sourceDigest` 를 단정, `05:285`)

**성공하지 못하면 착수 불가로 보고하고 멈춘다** (`05:301`). 편집 후에는 복구 수단이 없기 때문이다.

**시드 워크로드** (`02:628` — 직접 인용): `--clients 1,2,8 --wan-latency-ms 150 --seed 20260723 --repeats 5 --samples 30`

⚠️ **`wanJitterMs:20` 과 `wanLossPercent:0` 은 어느 연구 문서에도 없다.** 이전 판이 어디서 가져왔는지 확인되지 않는다 → **`[미확인]`**. 리허설 시 `02:628` 의 6개 인자만 쓰고, jitter/loss 가 실제로 CLI 인자로 존재하는지 확인한 뒤 기록한다.

**벤치마크는 가상 시간이라 부하 면역이지만 실제 CPU 를 태운다** — 지연 민감 테스트와 동시 실행 금지.

**republish 절차의 3단계** (`02:628-630`, 이전 판 누락):
1. 벤치마크 실행 (`tools/wave3/fair-scheduler-decision.test.mjs` — **테스트가 아니라 벤치마크 소스 실행**, `node tools/wave3/fair-scheduler-decision.test.mjs`)
2. `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json` 및 canonical authority 재발행
3. **`raw/manifest.json` 의 trial 인벤토리(15 경로 / 1650 샘플, `fair-scheduler-decision.test.mjs:61`, `:65`) 재생성**

> ⚠️ 이전 판은 *"republish CLI 가 저장소에 없다"* 로만 적고 멈췄다. `02:628-630` 이 **실행 가능한 경로**를 제시했다. "CLI 가 없다" 와 "절차가 없다" 는 다르다.

---

### S0.7 — 선행 결함: `FR-BGSTAB-017` recovery write gate ⚠️ **신설**

`00:93` — *"현재 snapshot/repair write 일부는 live scheduler 를 우회한다. 따라서 recovery write gate 가 binary 보다 먼저다."* `01:1189` 가 선행 #10 으로 등재.

**이전 판에는 `FR-BGSTAB-017` 이라는 문자열조차 없다.** 그런데 S4 는 `sendNonCoalescingOutputChunk`(`WsRouter.ts:6740-6769`, recovery tail) 를, S5 는 snapshot/repair 경로(`WsRouter.ts:4920-4940`, `:3223-3230`)를 건드린다.

**왜 선행인가**: scheduler 를 우회하는 write 가 남아 있으면 §4.2 의 `encodedBytes` 회계가 그 경로를 놓치고, S5 재벤치가 **실제 트래픽의 일부만 측정**한다.

**현재 상태 (직접 확인, `docs/spec/30.buildergate-stability.srs.md:1447-1458`)** — 이전 판은 target 을 밝히지 않아 `--target` 인자를 알 수 없었다 (2차 검증 L-25):

| 필드 | 값 | 줄 |
|---|---|---|
| 제목 | Frontend recovery write gate and queued input release barrier | `:1447` |
| **Target** | **`0.5.5-buildergate-stability`** — ⚠️ **`wave-3` 도 `wave-5` 도 아니다** | `:1452` |
| **Status** | **`planned`** = 미구현 | `:1453` |
| **Stability** | **`evolving`** | `:1457` |
| Risk | high | `:1456` |
| Verification Method | 프론트 recovery 스케줄러 단위 · TerminalView recovery 계약 · TerminalContainer 순서 · WebSocket 분류 · Playwright redraw/recovery (`https://localhost:2222`) | `:1458` |

**귀결 3가지**:
1. **Status=`planned` 이므로 미구현이 확정**이다 — "확인해 본다" 가 아니라 **선행 작업이 실재한다**
2. **Stability=`evolving` 이라 착수 가능**하다 (CLAUDE.md 상 `draft`/`deprecated` 만 차단)
3. **target 이 달라 Active Target 전환(S0-a)만으로는 조회되지 않는다** — `--target 0.5.5-buildergate-stability` 를 명시해야 한다

**게이트**: 미구현이므로 **S4 착수 전에 완료하거나 D11 로 사용자 결정을 받는다.**

**검증 커맨드** (cwd=루트):
```bash
npx speckiwi list --target 0.5.5-buildergate-stability --json   # FR-BGSTAB-017 Status 확인
npx speckiwi summary --target 0.5.5-buildergate-stability --json
```
MCP 가용 시 `get_requirement(id="FR-BGSTAB-017")` 로 검증 증거 유무를 직접 읽는다.

---

### S1 — payload 재파싱 제거 (JSON 상태, 관측 동작 불변)

`connectionEpoch` / `deliverySeq` / `deliveryKind` 를 `WsTransportMessage` **사이드카 필드로 승격**하고(`02:157-166`), §1.4 의 **5개 지점**이 payload 대신 사이드카를 읽게 한다.

| 항목 | 내용 |
|---|---|
| **실패 테스트** | 5개 지점 각각에 대해 "payload 가 JSON 이 아니어도 올바른 라우팅 결정을 내린다" |
| **경계 대조군** | 사이드카를 의도적으로 비웠을 때 **실패해야 한다.** 실패하지 않으면 사이드카를 안 읽고 있는 것이다 |
| **파일 위치** | 신규 `server/src/ws/wsTransportSidecar.test.ts` (**새 파일** — P2/P4 focused 목록 회피, `05:351`) |
| **소속 스위트** | B (node:test server). ⚠️ **A(`test-runner.ts`)가 디스커버리하지 않는다** |
| **검증 커맨드** | `npx tsx --test src/ws/wsTransportSidecar.test.ts` (cwd=`server/`) |
| **회귀 커맨드** | `npx tsx --test src/ws/wsSendPolicyRestoreMetadata.test.ts src/ws/FairTerminalDeliveryScheduler.test.ts src/ws/WsRouterSendPriority.test.ts` (cwd=`server/`) + `npx tsx src/test-runner.ts` (cwd=`server/`) |
| **핀 영향** | **P1** (wsSendPolicy.ts + WsRouter.ts) · **P2** · **P4**(테스트 추가 → `expectedFocusedTestNamesSha256`) |
| **핀 처리** | 완료 후 즉시 republish (S0.5 절차) → `node tools/wave3/canary-admission-evidence.test.mjs` · `node tools/wave3/retained-shadow-parity.test.mjs` |

이 리팩터는 바이너리와 무관하게 옳다(`01:1182`, `02:665`). `hasFairDeliveryIdentity` 가 **파싱 실패 시 `true`** 를 반환하는 것은 그 자체로 결함이다.

⚠️ **S1 은 §7 항목 1·2·6 도 함께 처리한다.** 특히 항목 1(vacuous ACK credit 단정)의 기대값은 **이 단계에서는 봉투 도메인**이어야 한다 — S1 의 계약이 *"JSON 상태, 관측 동작 불변"* 이기 때문이다. **본문-only 리터럴(12/9)로 바꾸는 것은 S1 이 아니라 §S5-a0** 이며, 그때 도메인이 실제로 바뀐다. 두 단계의 리터럴을 뒤바꾸면 S1 이 처음부터 red 다 (4차 검증 H-2, §7 항목 1 주).

---

### S2 — 프레임 인코더/디코더 (새 모듈, 핀 파일 무접촉)

`server/src/ws/binaryFrameCodec.ts` (신규) — 핀 파일 diff 를 만들지 않기 위해 **반드시 새 모듈**(`02:622`, `05:362`).

#### S2-a. 골든 벡터 — **왕복만으로는 구조적으로 vacuous**

⚠️ 이전 판은 "왕복 property test" 만 요구했다. `05:439` — *"서버 코덱과 브라우저 코덱은 **별개 구현**이다. 두 파일이 각자의 테스트에서 자기 자신과 왕복하면 **둘 다 틀려도 초록**이다."* (메모리 `check_operands_must_have_independent_origins`)

그리고 `01:1197` 이 이것이 이론적 우려가 아님을 확인했다: 프론트 복제본(`frontend/src/types/ws-protocol.ts`)과 서버 원본(`server/src/types/ws-protocol.ts`)은 **이미 drift 되어 있다** — `terminal-authority:*` 계열이 서버 union 에 **0종**, 프론트에 **6종** 선언되어 있다(직접 확인, §S2-c). `01:1197` — *"**차분 테스트(서버 인코딩 → 프론트 디코딩 → 원본 대조)를 라운드트립으로 강제**하지 않으면 같은 종류의 drift 가 반복된다."*

**[설계결정] 골든 벡터 파일 1개를 SSOT 로 둔다** (`05:441-450`, D4):

```
server/src/ws/__fixtures__/binary-frame-vectors.json
  [{ "name": "...", "message": {...}, "hexFrame": "01000000..." }, ...]
```

- 서버 테스트: `encode(message) === hex2bytes(hexFrame)` **및** `decode(hex2bytes(hexFrame)) ≡ message`
- 프론트 테스트: **같은 파일을 읽어** 동일 단정 (복사 금지 — `05:452`)
- ⚠️ **`hexFrame` 은 사람이 손으로 쓰거나 리뷰로 승인한 값이어야 한다.** 인코더 출력을 그대로 덤프해 fixture 로 만들면 **두 피연산자의 출처가 다시 같아진다** (`05:450`)
- ⚠️ **fixture 파일 위치는 `05:452` 의 `[설계결정]`** 이다 — *"`§10.2 중복 금지` 에 따라 **파일을 복사하지 말고 한 곳을 참조**한다"*. 합의된 사양이 아니라 판단이므로 D4 에서 확정한다
- ⚠️ **`hexFrame` 은 28B 헤더 기준으로 손계산한다** — `05` 의 예시 문자열(`"01000000…"`)은 21B 초안 시절의 자리표시자다(§2.3)

#### S2-b. Fault 케이스 + 경계 대조군 — **28B 기준으로 재작성** ⚠️

⚠️ **`05:458-467` 의 F1~F8 표와 `05:428` 의 P2 는 폐기된 21B 초안 기준이다.** `05:16` 이 프레임 초안을 `[opcode 1B][channelId 4B][streamEpoch 4B][sourceSeq 8B][length 4B]` = **고정 헤더 21B** 로 전제하고, 그 전제가 `05:100`(*"초안 헤더 21바이트로는 이 필드들이 다 안 들어간다"*) · `05:201`(*"헤더 21B 포함"*) · `05:428`(P2) · `05:460`(F1 대조군) · `05:734`(U4) 에 그대로 흐른다 (전부 직접 확인).

**`01` §1.1 이 28B 로 확정했으므로**(§1.2) `05` 의 숫자를 그대로 쓰면 **F1 의 경계 대조군이 28B 디코더에서 항상 `truncated-header` 로 실패**한다. 그러면 이 절이 인용하는 원칙 — *"그래도 실패하면 측정하던 게 fault 가 아니었던 것"* — 이 정확히 여기서 깨진다. 반대로 21B 로 구현하면 프레임 계약(`01:43-52`)이 어긋난다.

> **`05:458-467` 은 fault 의 *종류*와 각 경계 대조군의 *논리*에 대해서만 정본이다. 숫자·오류코드는 아래 표가 정본이다.** `05` 파일 자체는 수정하지 않는다 — 이 계획이 정정본을 보유한다(§2.3 참조).

**28B 기준 프레임 산수** (정본 — 헤더 표 `01:45-52`(캡션 **`01:41`** *"모든 정수는 big-endian (network byte order). **헤더 28바이트 고정.**"* — ⚠️ 이전 판의 `01:40` 은 **빈 줄**이다, 3차 검증-B L-6), OUTPUT 프롤로그 표 `01:490-496`(제목 `01:488`), 세그먼트 표 `01:500-507`(도입문 `01:498`)):

| 항목 | 값 |
|---|---:|
| 고정 헤더 (`frameVersion` `01:45` / `opcode` `:46` / `flags` `:47` / `channelId` `:48` / `streamEpoch` `:49` / `sourceSeq` `:50` / `payloadLength` `:51`) | **28 B** |
| `0x01 OUTPUT` 프롤로그 (`01:488`) — `PROLOGUE_PRESENT` 가 필수라 **항상 존재** | **24 B** |
| 세그먼트 1개 (`01:498`, `segmentCount > 0` 일 때) | **16 B** |
| **최소 유효 OUTPUT 프레임** (본문 0, `segmentCount=0`) | **52 B** (`payloadLength = 24`) |

⚠️ **"28바이트 헤더만" 은 유효 프레임이 아니다.** `PROLOGUE_PRESENT`(bit3, `01:78`)가 `MANDATORY_FLAGS = 0x0009`(`01:84`) 에 들어 있어 **협상 대상이 아니다**(`01:81`). 따라서 OUTPUT 프레임에는 프롤로그 24B 가 **항상 존재**하고, 헤더만 있는 28바이트 버퍼는 `payloadLength = 0` 이라 프롤로그가 없어 거부된다(F1 대조군·P7 정정본 참조).

⚠️ **`01:81` 의 조건을 뒤집어 옮기지 않는다** (3차 검증-B L-7). 이전 판은 *"**프롤로그 없는** OUTPUT 프레임은 디코더가 프롤로그를 본문으로 오독한다(`01:81`)"* 라 적었으나, **`01:81` 원문은 정반대 조건이다** (직접 확인):

> *"클라이언트가 bit3 를 뺐다고 서버가 프롤로그를 안 실을 수는 없고, **실은 채로 비트만 지우면** 디코더가 프롤로그를 본문으로 오독한다."*

즉 오독이 일어나는 것은 **프롤로그가 실려 있는데 `PROLOGUE_PRESENT` 플래그만 꺼진** 경우이며, 프롤로그가 아예 없는 경우가 아니다. 조건과 귀결이 성립하지 않는다. **`01:81` 이 실제로 지지하는 명제는 "bit3 는 협상 불가" 하나뿐**이고, "프롤로그가 항상 존재한다" 는 그 명제 + `MANDATORY_FLAGS`(`01:84`)에서 **파생**되는 것이지 `01:81` 이 직접 말한 것이 아니다. ⚠️ **이 오독 시나리오(프롤로그 실림 + 플래그 꺼짐)는 F10 의 변형으로 별도 fault 케이스가 될 수 있다** — 단 v1 에서는 `flags & ~activeFlagMask` 검사(`01:91`)가 아니라 **`MANDATORY_FLAGS` 누락 검사**가 잡아야 하는 사례이므로, **디코더가 `(flags & MANDATORY_FLAGS) !== MANDATORY_FLAGS` 를 검사하는지 S2 착수 시 `01` 부록 B 에서 확인한다** `[미확인]`. 확인한 사실: **`01:934-943` 의 rejection code 10종에 이 사례 전용 코드가 없다.** `mandatory-flag-not-accepted` 는 존재하지만 그것은 **협상 실패 사유**(`01:93`, 선언은 `01:673`)이지 프레임 거부 코드가 아니다 — F9 주가 지적한 `frameVersion` `0x00`/`0xFF` 와 **같은 종류의 구조적 공백**이다. **D9 와 함께 S2 착수 전에 처분을 정한다**(전용 코드 신설 vs `reserved-flag-set` 수렴 vs 진단 메타데이터).

**그리고 `channelId = 0` 은 영구 예약이라 `reserved-channel` 로 거부된다**(`01:48` 헤더 표 · `01:362` 규칙 1 · `01:939` rejection code) — 모든 대조군 벡터는 `channelId ≥ 1` 을 쓴다. `05:460` 이 말한 "헤더만, payload 0" 을 28B 로 단순 치환하면 **두 규칙에 동시에 걸린다.**

**P2 정정** (`05:428` 대체):

```
encode(m).byteLength === 28 + prologueBytes(opcode(m)) + 16 * segmentCount(m) + bodyBytes(m)
```

`0x01 OUTPUT` 은 `prologueBytes = 24`. 다른 opcode 의 프롤로그 크기는 `01` §1.8 이 정본이다.

**나머지 property 의 처분** — 이전 판은 *"P1·P3~P7 은 헤더 크기와 무관하므로 그대로 유효"* 라 했으나 **P7 은 그렇지 않다** (3차 검증 M-5):

| ID | `05` 원문 | 처분 |
|---|---|---|
| P1 (`05:427`) | `decode(encode(m)) ≡ m` | ✅ 그대로 |
| P3 (`05:429`) | `decode` 는 입력 버퍼를 변형하지 않는다 | ✅ 그대로. **뷰 반환(§S4-b)과 함께 보면 더 중요해진다** — 뷰를 주면서 버퍼를 안 건드린다는 것이 계약이다 |
| P4 (`05:430`) | 연접 스트림을 정확히 2개로 분해 | ✅ 그대로. 단 **`END_OF_BATCH` 는 마지막 프레임에만** 서야 하므로(`01:75`) 첫 프레임에 세우면 `batch-terminated-early` 다 — P4 벡터는 이 플래그를 올바로 세운다 |
| P5 (`05:431`) | `sourceSeq` 가 `0`,`1`,`2^53-1`,`2^53`,`2^64-1` 에서 왕복 | ✅ 그대로. 28B 가 8B 필드를 그대로 유지한다 |
| P6 (`05:432`) | UTF-8 다바이트 바이트 보존 | ✅ 그대로 |
| **P7** (`05:433`) | **"payload 가 빈 바이트열(`length=0`)일 때 왕복"** | ⚠️ **28B 계약에서 `0x01 OUTPUT` 은 `payloadLength = 0` 이 될 수 없다.** `PROLOGUE_PRESENT` 가 필수라 최소가 **24**(프롤로그)다. **P7 은 "빈 payload" 가 아니라 "빈 *본문*" 으로 재작성한다** |

**P7 정정본**:
```
// OUTPUT: payloadLength === 24 (프롤로그만, segmentCount=0, 본문 0바이트) 왕복
// 그리고 payloadLength === 0 인 OUTPUT 프레임은 거부되어야 한다 (프롤로그 부재)
```
**두 번째 줄이 경계 대조군이다** — 이것 없이 첫 줄만 두면 "빈 본문" 과 "프롤로그 없음" 을 구분하지 못한다. 이는 F1 대조군(52바이트 최소 유효 프레임)과 **같은 사실을 property 쪽에서 재확인**하는 것이며, 두 검사의 피연산자 출처가 다르므로 중복이 아니다.

**Fault 표 — 28B 정정본** (오류코드는 `01:934-943` 의 전수 10종과 1:1. **줄번호는 직접 grep 으로 재확인**):

| # | Fault | 기대 (rejection code) | **경계 대조군 (반드시 통과)** |
|---|---|---|---|
| F1 | 헤더 잘림 — **27바이트** | `truncated-header` (**`01:935`**: *"잔여 바이트 < 28"*) | **52바이트 최소 유효 OUTPUT 프레임**(헤더 28 + 프롤로그 24, `payloadLength=24`, `channelId=1`) → **성공해야 함**. 실패하면 "잘림" 이 아니라 "빈 본문 미지원" 또는 "프롤로그 미구현" 을 측정한 것 |
| F2 | payload 잘림 — `payloadLength=124`(프롤로그24+본문100) 선언, 실제 버퍼는 `28+24+90=142`바이트 | `length-overrun` (**`01:941`**: `off + 28 + payloadLength > buf.byteLength`) | **정확히 `28+124=152`바이트** → 성공. **`153`바이트**(잉여 1) → `batch-terminated-early`(**`01:942`**) — **F2 와 다른 코드여야 한다** |
| F3 | 미지원 opcode `0xFF` | `unknown-opcode` (**`01:937`**) — **조용히 drop 금지** | **정의된 최대 opcode = `0x07`**(`terminal-checkpoint:output`, **`01:166`**) → 성공. **미정의 최소값 = `0x08`**(예약 구간 시작, **`01:167`**) → 실패. 이 둘이 갈리지 않으면 opcode 검사가 아니라 다른 것을 재고 있다 |
| F4 | `payloadLength` 선언 < 실제 | `batch-terminated-early` (`01:942`: *"`END_OF_BATCH` 인데 버퍼 끝이 아님"*) | 정확히 일치 → 성공. **+1 은 `length-overrun`(`01:941`), −1 은 `batch-terminated-early`(`01:942`)** — 두 코드가 **달라야** 한다(같으면 길이를 안 읽고 있다) |
| F5 | 거대 payload — 정책 상한 초과. **상한은 `bodyBytes` 도메인** — 아래 F5 주 참조 (`screen-snapshot` 상한 **2 MiB = 2,097,152**, `config.schema.ts:77` — 인용 **`01:161`**) | 상한 초과 거부 — 메모리 폭발 없이 | **`bodyBytes = 2,097,152`**(→ `payloadLength = 2,097,176`) → 성공. **`bodyBytes = 2,097,151`** → 성공. **`bodyBytes = 2,097,153`** → 실패. 세 점이 다 확인돼야 상한을 재는 것 |
| F6 | `sourceSeq` u64 상한 초과 | **인코드 시점** 거부 (`isCanonicalOrdinal64`, `server/src/types/ws-protocol.ts:969` / `ORDINAL64_MAX` `:961`) | `2^64-1` → 성공 |
| F7 | 바이너리 프레임이 JSON 파서에 도달 | 명시적 실패 (조용한 return 아님) | **JSON 프레임이 같은 경로로 오면 정상 처리** → 성공. 이게 실패하면 분기 자체가 망가진 것 |
| F8 | JSON 프레임이 바이너리 디코더에 도달 | 명시적 실패. 서버측 대칭 코드는 `binary-frame-on-json-group`(**`01:934`**) | F7 의 대칭 |

**F9~F11 — 28B 헤더가 신설한 fault 3종** `[설계결정]`. 21B 초안에는 `frameVersion`·`flags`·`channelId=0` 규칙이 없었으므로 `05:458-467` 에 대응 항목이 없다. **`01` 이 rejection code 를 정의했으므로 대조군을 붙여 여기서 편입한다.**

| # | Fault | 기대 | **경계 대조군** |
|---|---|---|---|
| **F9** | 헤더 `frameVersion` ≠ 협상 값 (예: 협상 `0x01` 인데 `0x02` 도착) | `bad-frame-version` (**`01:936`**; 규칙 서술은 `01:631`) | 협상 값 `0x01` → 성공. **`0x00` 과 `0xFF` 도 같은 `bad-frame-version`** — 아래 주 참조 |
| **F10** | `flags & ~activeFlagMask !== 0` (예: bit2 또는 bit4 를 셈) | `reserved-flag-set` (**`01:938`**; 단일 정의 규칙은 **`01:91`**) | `flags = 0x000B`(v1 `activeFlagMask` 전체, `01:86`) → 성공. `flags = 0x0009`(MANDATORY 만, `01:84`) → 성공. **그리고 마지막 프레임에서 `END_OF_BATCH`(`01:75`) 를 뺀 것은 `batch-not-terminated`(**`01:943`**)로 F10 과 다른 코드**여야 한다 |
| **F11** | `channelId = 0` | `reserved-channel` (**`01:939`**; 규칙 1 은 **`01:362`**) — **`unknown-channel` 이 아니다** | `channelId = 1`(등록됨) → 성공. **미등록 `channelId`(등록되지 않은 양수) → `unknown-channel`(`01:940`) 이고 이것은 국소(scoped) 등급이라 배치 파싱이 계속돼야 한다**(**`01:958`** — 치명 등급 목록은 `01:957`). 두 코드가 같으면 §S2.5 의 채널 생명주기를 안 읽고 있는 것이다 |

> ⚠️ **F9 주 — `frameVersion` `0x00`/`0xFF` 에는 전용 rejection code 가 없다** (3차 검증 M-4). 이전 판은 F9 대조군에 *"`bad-frame-version` 이 아니라 **별도 거부**여야 한다"* 라고 적었으나, **`01:934-943` 의 10종에 그런 코드가 없다.** `01:936` `bad-frame-version` = *"헤더 `frameVersion` ≠ 협상 값"* 이고 협상 값이 `0x01` 인 이상 `0x00`·`0xFF`·`0x02` 가 **모두 이 한 코드로 수렴**한다. 그런데 06 자신이 `01:934-943` 을 **"전수"** 라 부르고 있으므로(부록), 이전 판의 F9 대조군은 **구현 불가능한 것을 요구**했다.
>
> **`01:45` 가 `0x00`/`0xFF` 를 "영구 예약" 이라 한 것은 송신 측 규약**(그 값을 절대 협상하지 않는다)이지 **수신 측 별도 코드가 아니다.** opcode 쪽(`01:171`)은 `unknown-opcode` 라는 전용 코드가 있어 대칭처럼 보이지만, frameVersion 쪽에는 대응물이 없다.
>
> **[설계결정] F9 는 세 값이 모두 `bad-frame-version` 임을 단정하는 것으로 확정한다.** 별도 코드를 만들지 않는다 — `01` 의 10종을 11종으로 늘리면 부록의 "전수" 서술과 디코더 등급표(`01:957`)를 함께 고쳐야 하고, 얻는 것은 진단 문자열 하나뿐이다. **다만 `0x00`/`0xFF` 프레임이 "협상 불일치" 가 아니라 "0 으로 채워진 버퍼" 일 가능성이 높다는 점은 진단 이벤트 필드로 구분**해 기록한다(코드가 아니라 메타데이터로). 이 판단은 **D9 와 함께 S2 착수 전에 확정**한다.

> ⚠️ **F5 주 — 2 MiB 상한의 도메인을 확정한다** `[설계결정]` (3차 검증-B M-3). 이전 판은 F1·F2·F4·P2·P7 을 전부 28B 기준으로 재계산하면서 **F5 만 재계산하지 않아 상한의 도메인이 미지정**이었다. 그대로 두면 대조군 세 점이 실행 불가능하다.
>
> 직접 확인한 사실: **`config.schema.ts:77`** 은 `maxSnapshotBytes: maxSnapshotBytes ?? maxBufferSize ?? 2097152` 로, **PTY snapshot 의 데이터(문자열) 크기**에 걸리는 상한이다 — 와이어 프레임 길이가 아니다. 그리고 **`0x02 SCREEN_SNAPSHOT` 프롤로그는 24B** — 제목 줄이 **`01:516`** `#### 0x02 SCREEN_SNAPSHOT (프롤로그 24B)` 이고, *"본문은 원시 ANSI UTF-8"* 은 그 아래 **`01:518`** 이다 (4차 검증 L-3 정정, 직접 확인. 이전 판은 두 사실을 `01:516` 하나에 묶었다). 프롤로그 24B 산수 자체는 옳다 — `seq`(8) + `cols`(2) + `rows`(2) + `mode`(1) + `truncated`(1) + `flags2`(2) + `authorityRevision`(4) + `authorityEpochIndex`(2) + `replayTokenIndex`(2) = **24**(`01:518`). 따라서 **`payloadLength = 24 + bodyBytes`** 이고, `payloadLength = 2 MiB` 와 `bodyBytes = 2 MiB` 는 **정확히 24바이트 차이**다.
>
> **[설계결정] 상한은 `bodyBytes` 에 건다.** 근거: 상한의 출처가 애플리케이션 데이터 크기(`config.schema.ts:77`)이고, 프롤로그는 opcode 별로 크기가 달라(OUTPUT 24 `01:488` / SNAPSHOT 24 `01:516` / **CHECKPOINT_CHUNK 12 `01:522`**) `payloadLength` 에 걸면 **같은 정책값이 opcode 마다 다른 데이터량을 허용**하게 된다. 이는 §3.1-A 가 `encodedBytes` 를 본문-only 로 정한 것과 **같은 이유**다 — 두 결정을 한 원칙으로 통일한다.
>
> **도메인을 정하지 않으면 "상한 +1 → 실패" 가 정책 검사를 트립하지 않을 수 있다** — `payloadLength` 기준으로 구현해 놓고 `bodyBytes` 기준으로 벡터를 만들면 24바이트 창에서 판정이 어긋난다. **이는 §S2-b 가 F1 에 대해 이미 지적한 함정과 같은 종류다.**
>
> ⚠️ 그리고 **F5 는 F2(길이 필드 검사)와 섞이면 안 된다** — 아래 공통 규칙의 F5 항목 참조: `payloadLength` 만 크게 **선언**하는 방식은 상한 검사가 아니라 F2 를 재게 된다. **길이가 일치하는 실제 2 MiB 프레임을 만든다.**

**공통 규칙** (메모리 `boundary_control_for_fault_tests`): **각 fault 를 임계값 아래로 줄여 재실행했을 때 통과해야 한다. 그래도 실패하면 측정하던 게 fault 가 아니었던 것이다.**

특히:
- F3(opcode): **D9 확정 없이는 성립 불가** (§3.2). `01` §1.3(`0x01`~`0x07` 사용 = `01:160-166` / `0x08`~`0x3F` 예약 = `01:167` / `0x80` `JSON_ENVELOPE` 예약 = `01:169` / `0x00`·`0xFF` 영구 예약 = `01:171`)을 그대로 채택하면 즉시 종결된다
- F5(거대 payload): `05:469` 는 21B 와 무관하게 유효하다 — `payloadLength` 만 크게 **선언**하는 방식은 "상한 검사"가 아니라 **F2 를 재게 된다**. **길이 일치하는 큰 프레임 1개는 반드시 실제로 만든다**
- **관측 카운트 하한 단정**: `assert.ok(observedOutputFrames > 0)` — `05:479-481` 이 *"§3.3 의 vacuous green 을 구조적으로 막는 **유일한 방법**"* 이라 못 박았다
- **F1~F11 의 fault 벡터도 골든 벡터 파일(§S2-a)에 넣는다.** 인코더로 생성하면 `05:450` 의 "출처가 같아지는" 문제가 fault 쪽에서 재발한다

#### S2-c. opcode 표는 union 에서 생성하지 **않는다** — 정확한 셈법

`server/src/types/ws-protocol.ts` 의 `ServerWsMessage` union 은 wire 의 완전한 목록이 아니다. `terminal-authority:*` 계열이 통째로 빠져 있다(`01:131`).

⚠️ **이전 판의 "12종" 은 셈법 없이 인용된 숫자였다.** 직접 세어 본 결과는 아래와 같다.

| 셈법 | 수 |
|---|---:|
| `server/src` 전체에서 distinct `'terminal-authority:*'` 문자열 리터럴 | **17** |
| 같은 범위에서 distinct `type: 'terminal-authority:*'` 객체 리터럴 | **14** |
| **비테스트 소스만** (`--exclude=*.test.ts`) distinct `type:` 객체 리터럴 | **10** |
| `server/src/types/ws-protocol.ts` 의 선언 | **0** |
| `frontend/src/types/ws-protocol.ts` 의 선언 | **6** (S→C 3: `:335` `:346` `:376` / C→S 3: `:405` `:409` `:425`) |

**"12" 가 나오는 유일한 셈법** (직접 확인):

> **S→C 방향, 비테스트 서버 소스에서 실제 조립되는 distinct 메시지 타입 = 10 + 2 = 12**
>
> - 10 = `type:` 객체 리터럴 (`canary-decision` · `compatibility-drain-accepted` · `legacy-responder-enabled` · `parser-reset` · `promotion-aborted` · `responder-disable-accepted` · `responder-disable-boundary` · `rollback-start` · `view-attributes-accepted` · `view-stale`)
> - **+2 = `WsRouter.ts:2992-2993` 의 삼항 분기** (`query-reply-accepted` / `query-reply-rejected`) — `type:` 리터럴이 아니라 삼항 결과라 위 grep 에 안 잡힌다

나머지 4종(`canary-request` · `compatibility-drained` · `responder-disabled` · `view-attributes`)은 **C→S** 이고, `queue-blocker` 는 테스트 파일에만 있다.

**→ union 기반 opcode 표 생성은 이 12종을 조용히 누락시킨다.**

#### S2-d. opcode 네임스페이스는 **방향별로 분리**한다 (`01:173` — **`[설계결정]`**, 합의된 사양 아님)

`screen-repair` 는 **같은 `type` 문자열이 양방향에 존재하는데 구조가 전혀 다르다**: C→S 요청은 `ScreenRepairRequestMessage`(`ws-protocol.ts:618-626`), S→C 패치는 `ScreenRepairMessage`(`:648-660`). 현행 JSON 에서는 방향이 곧 판별자라 문제가 없다. **opcode 표를 방향 구분 없이 기계 생성하면 두 타입이 하나의 opcode 로 접힌다.** v1 의 C→S 는 전부 JSON 이므로 **C→S opcode 표는 비어 있다.**

#### S2-e. `[미확인]` — "output 소켓 = 바이너리" 는 성립하지 않는다

`01:152` — `sendTerminalAuthorityFrameToConnection` 의 lane 인자는 대부분 `'terminal'` 이므로 **split 모드에서 이 JSON control 프레임들이 output 소켓으로 간다.** WS 는 텍스트/바이너리 프레임 순서를 보장하므로 정확성 문제는 없으나, 단순화가 성립하지 않는다.

`01:154` `[미확인]` — *"12종 각각의 lane 을 전수 확인하지는 않았다. **바이너리 그룹의 소켓별 codec 배선을 확정하기 전에 전수 확인이 필요하다.**"* lane 은 종별로 다르다: `responder-disable-accepted` 는 `'control'`(`TerminalAuthorityProductionAdapter.ts:2317`), `query-reply-*` 는 `sendPriorityControl` 경로(`WsRouter.ts:2990`).

#### S2-f. Ordinal64 런타임 단언 (`01:1198`)

`Ordinal64 = string` 은 **브랜디드 타입이 아니다**(`server/src/types/ws-protocol.ts:16` — 직접 확인). 생성 지점이 전부 `as Ordinal64` 단순 캐스트이므로 컴파일러가 잘못된 대입을 막지 못한다. → **인코더 입구에 런타임 단언 `isCanonicalOrdinal64`(`ws-protocol.ts:969`)를 둔다** (`01:1376`, `:1378`).

| 항목 | 내용 |
|---|---|
| **파일 위치** | 신규 `server/src/ws/binaryFrameCodec.ts` + `server/src/ws/binaryFrameCodec.test.ts` + `server/src/ws/__fixtures__/binary-frame-vectors.json` |
| **소속 스위트** | B (node:test server) — **A 는 안 돈다** |
| **검증 커맨드** | `npx tsx --test src/ws/binaryFrameCodec.test.ts` (cwd=`server/`) |
| **핀 영향** | **조건부 0** — 새 파일만 만들므로 핀 파일 diff 는 0. **단 새 `*.test.ts` 를 P2 `focusedCommands`(`:58-79`) 나 P4 focused 목록에 넣는 순간 P2·P4 가 동시에 붙는다**(§1.5 매트릭스 각주 ¹). ⚠️ **넣지 않는다** |

---

### S2.5 — `channelId` 할당·생명주기 ⚠️ **신설**

이전 판은 `channelId` 를 헤더에 넣었으나(§1.2) **할당하는 단계가 없었다.** `02:551` 은 이 작업을 난이도 **M / 위험 높음** 으로 매기고 *"매핑 누락 시 프레임이 엉뚱한 세션으로 간다"* 고 경고했다.

정본은 `01` §1.5 다. 필수 규정:

| 항목 | 규정 | 근거 |
|---|---|---|
| **스코프** | **`clientGroupId` 스코프** — 소켓 스코프 아님 | **`01:330-334`.** 근거는 `WsRouter.ts:1111-1113` 의 폴백 — `lane === 'terminal' && group?.output?.readyState === WebSocket.OPEN ? group.output : control` 이라 terminal payload 가 control 소켓으로 옮겨간다. ⚠️ **이 코드에 `@req` 태그는 없고 `FR-BGSTAB-007` 문자열은 `server/src` 전체에 0회다**(전수 grep). **`FR-BGSTAB-007` AC-3/AC-4 라는 귀속은 `01:330-334` 의 서술이지 코드 주석이 아니다** (2차 검증 L-15) |
| **할당 시점** | `handleSubscribe` 성공 시(`WsRouter.ts:2559-2634`) → `subscribed` 응답(`:2633`)의 `SubscribedSessionInfo` 에 실어 보냄 | `01:338-355` |
| **`channelId = 0`** | **영구 예약.** 디코더는 `unknown-channel` 이 아니라 **`reserved-channel`** 로 명시 거부 | `01:362` |
| **⚠️ codecEpoch 내 재사용 금지** | 해제된 값을 **같은 codecEpoch 안에서 재사용하지 않는다** | `01:363` |
| **재사용이 왜 위험한가** | `01:368-375` 의 교차세션 손상 시나리오 — 채널 7 이 sessionA→sessionB 로 재할당되면 버퍼에 남은 A 의 프레임이 **B 의 화면에 그려진다.** **`sourceSeq` 단조 검사(`terminalWriteCoordinator.ts:1140-1143`)로 못 잡는다** — 새 채널의 `latestSourceSeq` 가 없어 검사가 건너뛰어진다(`:1135` truthy 가드). **재사용 금지가 유일한 구조적 방어다** | `01:366-375` |
| **3-state 생명주기** | `ACTIVE → RETIRED → FREE`. RETIRED 는 조용히 폐기하되 진단 이벤트(`terminal_binary_retired_channel_frame`)를 남긴다 — 클라이언트가 이미 그 세션을 버렸으므로 그릴 화면이 없다(silent drop 아님) | `01:381-397` |
| **유예 30s** | 새 상수를 만들지 않고 `pairTokenExpiresAt` 과 같은 30초(`WsRouter.ts:1690`). **`PERF-BGSTAB-010` AC-4 의 "정책값은 `TerminalResourcePolicy` 에서 파생" 요구 때문** | `01:397` |
| **서버 주도 해제 통지** | `terminal-binary:channel-retired`. 클라이언트 주도 `unsubscribe` 는 통지 안 함 | `01:399` |
| **미지 channelId** | 버리지 않고 `terminal-binary:unknown-channel` 전송 후 **그 채널만** fresh snapshot 요청. 전 연결을 끊지 않는다 | `01:401-403` |

⚠️ **`PERF-BGSTAB-010` AC-4 파생 규칙**: `01:397` 과 `01:477` 이 **두 번** 인용한다 — *"새 정책 상수를 도입하면 계약 위반"*. **S2.5(30s 유예)와 S4(배치 상한 = `bulkSliceBytes`) 둘 다 상수가 필요하다.** 전부 기존 정책값에서 파생시킨다.

| 항목 | 내용 |
|---|---|
| **파일 위치** | 신규 `server/src/ws/binaryChannelRegistry.ts` + `.test.ts` |
| **검증 커맨드** | `npx tsx --test src/ws/binaryChannelRegistry.test.ts` (cwd=`server/`) |
| **핀 영향** | **P1**(`WsRouter.ts` 의 subscribe/unsubscribe/disconnect 훅) · **P2** · **P4**(`server/src/types/ws-protocol.ts` 확장) |

---

### S3 — silent drop 제거 (현행 결함 수정)

바이너리와 무관하게 **이미 위반 중**이다.

⚠️ **집합 확정 — 이 계획은 8항목을 쓴다** (2차 검증 H-2). 이전 판은 *"`05:168-176` 은 7곳"* 이라 써 놓고 8행 표를 실었고, 그 차이를 *"파서 3곳을 1행으로 묶어 7항목"* 이라 설명했다. **그 설명은 틀렸다** — 직접 확인 결과 **`05:168-176` 은 이미 파서 3곳(`:173`)을 1행으로 묶은 상태로 정확히 7행(`:170`~`:176`)** 이다. **8−7 의 차이는 이 계획이 추가한 `WsRouter.ts:1745` 행 하나**이며 `05` 에는 없다.

| 집합 | 항목 수 | 구성 |
|---|---:|---|
| **`05:170-176` 정본** | **7** | 프로덕션 프론트 1 + 프론트 테스트 5(파서 3곳은 `:173` 1행) + 서버 node:test 1 |
| **이 계획의 S3 대상** | **8** | 위 7 + **`server/src/ws/WsRouter.ts:1745` (서버 프로덕션)** |

**8 을 채택하는 이유**: `:1745` 는 `JSON.parse` 실패 시 `console.warn` 후 return 하는 **서버 프로덕션 경로**이고, S3 의 `isBinary` 도입이 바로 그 지점을 지나간다. 빼면 S3 이 자기가 고치는 것을 안 세게 된다. **`05` 를 인용할 때는 7, 이 계획의 진입 조건·체크리스트는 8** — 전 참조를 이 규칙으로 통일했다(§9, §13, §S4-d).

아래 8행은 직접 확인 결과 전부 실재한다.

| # | 위치 | 현재 코드 | 위험 |
|---|---|---|---|
| 1 | **`frontend/src/contexts/WebSocketContext.tsx:688-690`** (프로덕션) | `catch { return; }` | **제품 자체가 조용히 프레임을 버린다** |
| 2 | **`server/src/ws/WsRouter.ts:1745`** (프로덕션) | `JSON.parse(...)` 실패 → `console.warn` 후 return | 클라이언트는 자기 메시지가 버려진 줄 모른다 |
| 3 | `frontend/tests/e2e/wave1-retained-state-characterization.spec.ts:632` | `if (typeof raw !== 'string') return;` | `'output'` 필터(`:674`)가 영구 0건 → **vacuous** |
| 4 | `frontend/tests/e2e/terminal-authority.spec.ts:150` | `if (typeof data !== 'string') {` | `screen-snapshot` 단정(`:209`, `:221`) vacuous |
| 5 | `frontend/tests/support/perfBgstab010Ac6BrowserAckHarness.ts:45`, `:129`, `:191` | `if (typeof raw !== 'string') return null;` **×3** | 세 파서 전부 |
| 6 | `frontend/tests/e2e/wave1-split-characterization.spec.ts:393` | `if (typeof frame.payload !== 'string') {` | **`:412`** 주석(*"Non-JSON terminal output is not production-path evidence."*)의 전제가 무너짐. ⚠️ **`:411` 은 `} catch {`** 다 (3차 검증-B L-5, 직접 확인 — `05:174` 에서 상속된 오차) |
| 7 | `frontend/tests/e2e/grid-equal-mode.spec.ts:470` | `if (typeof data === 'string') {` | control 캡처만 |
| 8 | `server/src/ws/WsRouterRestoreMetadata.test.ts:110-117` | try/catch → `return` | **타임아웃**으로 나타남 |

> `05:178` — **이 목록의 모든 지점을 0 으로 만드는 것이 §8 shadow 단계의 진입 조건이다.** (`05` 기준 7항목 + 이 계획이 추가한 `WsRouter.ts:1745` = **8항목**) `05:180` — *"통과한 테스트가 무엇을 실제로 관측했는지 세지 않으면, 관측이 0건이어도 초록이다."*

#### `isBinary` 인자 도입 — 리스너 등록 **2곳**

⚠️ 이전 판은 `WsRouter.ts:1745` 만 지목했으나 그것은 **하류**다. 직접 확인:

| 위치 | 현재 |
|---|---|
| **`WsRouter.ts:1638`** (output 소켓) | `ws.on('message', (raw: Buffer \| string) => {` — **`isBinary` 미선언** |
| **`WsRouter.ts:1718`** (control 소켓) | 동일 |
| `WsRouter.ts:1742` `handleMessage` | 시그니처 확장 대상 |
| `WsRouter.ts:1745` | 그 하류의 `JSON.parse` |
| `WsRouter.ts:2534` `handleMessageError` / `:2553` `tryParseRawMessage` | **바이너리 raw 에 `JSON.parse` 를 재시도하지 않도록 확장** (`02:450`) |

`@types/ws` 의 실제 시그니처는 `(data: WebSocket.RawData, isBinary: boolean)` 이다(`01:895`).

⚠️ **ws v8 의 `RawData = Buffer | ArrayBuffer | Buffer[]`** 다 — string 을 절대 주지 않는다(`01:897`). **`Buffer[]` 케이스에서 `raw.toString()` 은 `,` 로 join 되어 조용히 깨진다.** 현재 타입 선언 `Buffer | string` 은 부정확하다. S3 에서 함께 정정한다.

#### 클라이언트 측 (`03` §3.2, §3.4)

- **`binaryType='arraybuffer'` 를 두 소켓 모두에** — `WebSocketContext.tsx:1201`(control) 과 `:1007`(output). 설정 시점은 소켓별로 **다른 앵커**를 쓴다 (직접 확인, 2차 검증 L-18):
  - control: **`03:97`** — *"`:1201` 직후, **`:1206` 의 `wsRef.current = ws` 이전**"*
  - split output: **`03:98`** — *"`:1007` 직후, **`:1009` 의 `onmessage` 할당 이전**"*

  ⚠️ 이전 판은 *"`onmessage` 할당 전"* 을 두 소켓에 일괄 적용하며 **`05:86`** 을 근거로 들었으나, **`05:86` 에는 순서에 대한 언급이 없다** — 그 줄이 말하는 것은 *"`binaryType` 을 설정하는 코드가 `frontend/src` 어디에도 없다 … 두 소켓 모두 기본값 `'blob'` 이다"* 라는 **부재 사실**이다. 순서 근거는 `03:97`/`03:98` 뿐이다. 이전 판은 `:1201` 만 필수로 적었으나 `:1007` 도 필수 행이다(`03:743`)
- **2단계 분기 + Blob 명시 거부** (`03:113`, `03:747`): `ArrayBuffer` → 바이너리 / **비-string(Blob) → 명시적 거부 + 기록** / string → 기존 JSON. *"여기서 조용히 흘려보내면 §3.1 의 오설정이 런타임에 드러나지 않는다"*
- **JSON 경로는 영구 유지** (`03:744`, `03:523`) — downgrade 용. 바이너리 전환 후에도 제거하면 안 된다
- **디코더 오류 등급 분류** (`01:949-958` `[설계결정]`): *"디코더가 오류마다 즉시 `return err(...)` 하면 이미 파싱한 앞쪽 프레임들이 통째로 사라진다 … silent drop 금지에 정면으로 걸린다."* → **치명(fatal, `01:957` — 9종) vs 국소(scoped, `01:958` — `unknown-channel` 1종)** 로 나누고 `{frames, fatal?}` 를 반환한다. 치명 등급에서도 **이미 파싱된 프레임을 먼저 디스패치**한다. **rejection code 10종은 `01:934-943` 이 정본**

#### subprotocol 협상 (§6 층 1) — **S3 소관이나 이전 판의 작업 목록에 없었다** ⚠️

§6 층 1 이 subprotocol 협상을 **S3 에 배정**해 놓고, §S3 의 파일 위치·검증 커맨드·핀 영향 어디에도 해당 항목이 없었다 (3차 검증-B L-8). **`isBinary` 도입과 같은 단계에 있어야 하는 이유는 명확하다** — 소켓이 바이너리를 받을 수 있다고 선언하지 않은 채 ingress 분기만 만들면, 그 분기는 S4 까지 한 번도 실행되지 않아 **S3 의 테스트가 전부 vacuous** 해진다.

| 위치 | 작업 | 확인 |
|---|---|---|
| **`WsRouter.ts:612`** `this.wss = new WebSocketServer({ noServer: true });` (직접 확인) | `handleProtocols` 추가 — 근거는 **`01:611`** *"서버는 `WebSocketServer` 생성 시(`WsRouter.ts:612`) `handleProtocols` 를 준다. 선택 결과는 `ws.protocol` 로 양쪽이 읽는다"* (4차 검증 L-4 정정. 이전 판의 `01:619` 는 **클라이언트 측** 서술 — *"현재 두 소켓 생성 지점 모두 subprotocol 인자를 쓰지 않는다 … 인자 추가가 전부다"* — 이라 서버 행의 근거가 될 수 없다) | ⚠️ **P1 핀 파일이다.** 이 줄을 저장하는 순간 P1 이 red → **republish 필요** |
| `WebSocketContext.tsx:1201` (control) | `new WebSocket(url, ['buildergate.v1.binary','buildergate.v1.json'])` — **인자 추가가 전부**(`01:619`) | P2·P3 핀 파일 |
| `WebSocketContext.tsx:1007` (split output) | 동상 | P2·P3 핀 파일 |
| `connected` 의 `negotiatedSubprotocol` 에코 | `01:720` — split 에서 **control 소켓이 output 소켓의 협상 결과를 알아야** 한다 | `ws-protocol.ts:795` union 이 실제 wire 보다 좁은 기존 문제도 함께 교정 |

**RED 테스트**: 서버가 `buildergate.v1.binary` 를 제안받았을 때 그것을 선택하고, 제안이 없으면 **연결을 거부하지 않고 JSON 으로 수렴**해야 한다(RFC 6455 다운그레이드, `01:616`). 경계 대조군 — **subprotocol 을 하나도 보내지 않는 구 클라이언트가 정상 연결**되어야 한다. 이것이 실패하면 협상이 아니라 연결 자체를 재고 있는 것이다.

| 항목 | 내용 |
|---|---|
| **파일 위치** | 신규 `frontend/tests/unit/wsFrameDispatch.test.ts` (`05:370`) + 위 8곳 수정 + **subprotocol 3지점**(`WsRouter.ts:612` · `WebSocketContext.tsx:1201` · `:1007`) |
| **소속 스위트** | C (frontend node:test) + B(서버측) + D(E2E 수정분) |
| **검증 커맨드** | `node --experimental-strip-types --test tests/unit/wsFrameDispatch.test.ts` (cwd=`frontend/`)<br>`npx tsx --test src/ws/WsRouterBinaryIngress.test.ts` (cwd=`server/`, 신규)<br>**`npx tsx --test src/ws/WsRouterSplitHandshake.test.ts`** (cwd=`server/`, 기존 — subprotocol 이 핸드셰이크 경로를 건드리므로) |
| **회귀 커맨드** | `npx playwright test tests/e2e/terminal-authority.spec.ts tests/e2e/grid-equal-mode.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`) |
| **핀 영향** | **P1**(`WsRouter.ts` — `isBinary` **및 `:612` subprotocol**) · **P2**(WebSocketContext.tsx) · **P3**(`--expect-red` — D6 필요) · **P4**(테스트 이름 추가) |

---

### S4 — 서버 송신 + 클라이언트 수신 배선 → `binary-shadow`

#### S4-a. 서버 인코드 표면 — **1곳이 아니다**

이전 판은 *"인코드 1곳(`wsSendPolicy.ts:91`), 소켓 write 1곳(`WsRouter.ts:6268`)"* 이라 했다. 소켓 write 는 맞다 — **직접 확인 결과 `WsRouter.ts` 전체에서 `ws.send(` 는 `:6268` 단 1곳**이다. 그러나 인코드 측은 다르다. `02:29-118` 이 **7개 개입 지점**을 번호로 매핑했는데 이전 판은 2개만 다뤘다.

| # | 위치 | 하는 일 | S4 의 처분 |
|---|---|---|---|
| ① | `SessionManager.ts:1353` | `ptyProcess.onData((rawData: string))` — **소스가 이미 JS string** | `02:554` — *"**어디서 인코딩할지가 곧 어디까지 문자열로 다루는지의 경계**"*. 경계 위치를 명시 결정한다 |
| ② | **`wsSendPolicy.ts:598-611`** `fairDeliveryBytes()` | 회계 목적으로 `createWsTransportMessage(...)` **재호출** 후 `.byteLength`(`:610`)만 취한다 (직접 확인). ⚠️ **이 값이 곧 오늘의 `encodedBytes` 도메인 = JSON 봉투 전체**다 (§3.1-B) | **S4 에서는 손대지 않는다.** 이 함수의 교체는 `encodedBytes` 도메인 전환이므로 **S5-a0 소관**이다 — S4 는 `binary-shadow`(관측 동작 불변)이고 도메인 전환은 관측 가능한 회계 변화다. 전환 후 형태는 `Buffer.byteLength(input.payload,'utf8')` 이며 **회계 전용 JSON 생성이 사라진다 (CPU 이득 항목)** |
| ③ | `wsSendPolicy.ts:91` | `JSON.stringify(wireMessage)` — 유일한 payload 생산자 | codec 분기 |
| ④ | `wsSendPolicy.ts:95` | `Buffer.byteLength(payload,'utf8')` | §4.2 두 도메인 |
| ⑤ | `wsSendPolicy.ts:216` `tryCoalesceOutputMessage` | JSON 재생성 → `Buffer.concat` | §4.5 |
| ⑥ | `WsRouter.ts:6268` | `ws.send(message.payload, cb)` — **유일 송신 지점** | `{ binary: true }` 명시 필요 여부는 `[미확인]`(`02:678`) |
| ⑦ | `WsRouter.ts:6396` | `isFairTerminalDeliveryTransportMessage` — `JSON.parse` | S1 에서 처리됨 |

**이전 판이 빠뜨린 두 지점** (직접 확인):

| 위치 | 내용 |
|---|---|
| **`WsRouter.ts:5842-5850`** | fair-delivery send 콜백이 **두 번째 wire 객체를 생성**한다 (`:5852-5860` 의 `{type:'output', data: delivery.payload, ...}`). **`:5846` 에서 `...JSON.parse(delivery.payload)` 로 dataGap payload 를 재파싱**한다 |
| **`WsRouter.ts:5099`** | dataGap `JSON.stringify({...})`. `05:104-116` 이 **근본 원인을 `FairTerminalDeliveryInput` 의 `payload: string` 으로 추적**했다 — ⚠️ **그 필드는 `wsSendPolicy.ts:499` 다.** `:495` 는 인터페이스 헤더 `export interface FairTerminalDeliveryInput {` 이다 (2차 검증 L-2, 직접 확인). 참고로 `FairTerminalDelivery.encodedBytes` 는 **`:510`**(`02:185`·`02:538` 의 `:511` 은 닫는 중괄호). 스케줄러의 payload 타입이 문자열이라 미리 문자열화한다. **credit 산수(§4.2)와 직결** |

**[설계결정]** dataGap 은 control 성격이므로 **JSON 유지**(`02:127`). 단 scheduler `payload` 타입이 넓어지면 이 경로가 문자열임을 **타입으로 구분**해야 한다.

⚠️ **`01:810-835` 가 `02:217` 을 대체한다** — **§4.3 이 이미 이 결론으로 통일되어 있다**(이전 판은 §4.3 과 여기가 서로 다른 타입을 지시했다, 2차 검증 M-4). `payload: string | Uint8Array` + `encoding` 필드로는 **S6 의 롤백 보장을 구현할 수 없다.**

```ts
type WirePayload =
  | { codec: 'json';   text: string }
  | { codec: 'binary'; bytes: Uint8Array; codecEpoch: number };
```

`encodeFor(ws, message)` 가 **소켓에서** codec 을 도출한다(`01:827-832`). `01:835` — *"이 구조에서 **'JSON 전용 소켓에 바이너리 프레임을 보낸다'는 상태가 코드로 표현되지 않는다**."* `{codec:'binary'}` 는 `text: string` 필드를 갖지 않으므로 `ws.send(text)` 경로에 넣으려면 **없는 필드를 읽어야 해 컴파일되지 않는다**(`01:1064`).

그리고 `01:1066-1081` 이 `WsRouter.ts:6249` 의 기존 binding 검사 **바로 아래**에 `payload.codecEpoch !== groupCodecEpoch(ws)` 게이트를 두어 `codec-epoch-retired` 로 종결시킨다 — **재인코딩하지 않고 버리고 정산한다.**

#### S4-b. 클라이언트 — **난이도 L / 위험 높음 / 차단 전제 있음**

이전 판은 이 작업을 3줄로 적었다. `03` 은 같은 작업을 **난이도 L, 위험 높음**으로 매기고 **차단 전제**를 단다.

> `03:756` — `TerminalContainer.tsx:3192-3443` `onOutput` 핸들러 **전체 재작성**. *"시그니처 교체가 아니라 핸들러 재작성. **§3.5 방안 확정 전 착수 불가**"*

**`03:179-185` 의 신규 상태 3종** — 전부 "필드를 옮겨 담는" 수준이 아니라 **새 상태를 갖는** 일이다:

| # | 신규 상태 | 내용 |
|---|---|---|
| 1 | **`authorityEpochIndex` ↔ UUID 매핑 테이블** | 바이너리는 인덱스만 주고 매핑은 JSON control 로 온다 → **두 평면 간 상태 동기화**가 새로 생긴다. `03:181` `[미확인]` — *"매핑이 도착하기 전에 그 인덱스를 쓰는 프레임이 오면 어떻게 할지"* 순서 보장 미확인 |
| 2 | **`replayToken`/`repairToken` 채널 상태** | 지금은 stateless(메시지마다 동봉) → **stateful**. 재연결·epoch 롤백 시 언제 버릴지가 **새 계약** (`03:182`) |
| 3 | **ACK 도메인 `deliverySeq` → `sourceSeq`** | 기존 ACK 경로(`TerminalContainer.tsx:3377-3379`, `:3398-3402`)가 **통째로 바뀐다** (`03:183`) |

**이전 판이 빠뜨린 필수 항목**:

| 항목 | 근거 | 내용 |
|---|---|---|
| **디코더는 처음부터 배치 루프** | `03:194` | *"1:1 을 가정한 `byteLength !== 28 + payloadLength` 검사는 **전 트래픽을 폐기**한다"* |
| **view 보존 (복사 없음)** | `03:138`, `03:140` | ⚠️ **`03:138` 은 아직 `new Uint8Array(buffer, 21, length)` 로 쓰여 있다** — `03` 의 디코더 의사코드는 §2.3 이 정리한 대로 **21B 초안 기반**이다. 이전 판은 이 값을 조용히 `28` 로 고쳐 인용했다 (2차 검증 M-14). **확정 오프셋은 `28 + 프롤로그` 이므로 본문 뷰는 `new Uint8Array(buffer, off + 28 + prologueBytes + 16*segmentCount, bodyLen)`** 이다(헤더 표 `01:45-52`, OUTPUT 프롤로그 표 `01:490-496`, 세그먼트 표 `01:500-507`). 어느 쪽이든 **뷰**이므로 `.slice()` 를 쓰면 이득이 사라진다. ⚠️ **단 뷰가 큐에 살아 있으면 원본 `ArrayBuffer` 전체(= DRR quantum)가 GC 되지 않는다** → 큐 보관 시 `.slice()` 분리 또는 회계 변경 중 **반드시 하나**. §9.3 복사-0 이득과 **정면 상충하는 유일한 지점**(`03:800` #3) |
| **restore 게이트 `terminalOutputScheduler.ts:459-462`** | `03:460`, `03:752`, `03:788` — **3회 경고** | *"**output 평면 몫이다.** snapshot 범위로 오인해 미루면 **restore 대기 중 보류된 live 출력이 전부 거부된다**"*. 이 큐는 `bufferedOutputRef` 이고 채우는 것은 `TerminalView.tsx:1745` `bufferOutputWhileRestorePending`(호출 `:2909`, flush `:2096`) |
| **`enqueueLegacy` + retry defer** | §4.4 | 변환 장벽 3곳 전부 |

#### S4-c. xterm 이중 디코더 순서 위험

`_stringDecoder`(`StringToUtf32`)와 `_utf8Decoder`(`Utf8ToUtf32`)가 **별개 인스턴스**이고 `Utf8ToUtf32` 가 `interim` 3바이트를 보류한다(`03:346-353`). string write 와 bytes write 를 섞으면 **순서가 뒤집힌다**(`03:359`).

⚠️ **checkpoint 평면 때문에 이 조건은 오늘 이미 성립한다**(`03:337`) — 신규 위험이 아니라 **기존 조건의 일반화**다. 따라서:
- **RED 테스트를 신규 계약이 아니라 회귀 테스트로 세운다**(`03:341`)
- 현행 코드에 이미 결함이 있는지 **먼저 조사할 의무**가 있다(`03:340` `[미확인]`)
- 빈 문자열 write 는 안전하다 — 두 디코더 모두 `if(!i) return 0`(`03:360`)

#### S4-d. 사다리 진입: `binary-shadow`

**동작** (`05:554-562`): 서버가 output/snapshot 을 JSON 과 바이너리 **양쪽으로 인코딩**한다. 와이어에는 **JSON 만** 나간다. 바이너리는 디코드해서 JSON 과 **의미 동등성**(바이트 동등 아님)을 비교하고 불일치를 카운트한다.

**parity comparator** 는 `05:368` 이 정본: 신규 `server/src/ws/binaryShadowParity.test.ts`.

| 항목 | 내용 |
|---|---|
| **진입 조건** | S1~S3 green · S0.5 리허설 성공 · **§S3 의 조용한 폐기 경로 8항목**(= `05:170-176` 의 7 + `WsRouter.ts:1745`, §S3 상단 집합 확정 참조) **이 전부 명시 실패로 전환됨** (`05:559`) |
| **측정** | ① 의미 불일치 건수 ② 인코딩 CPU 오버헤드(양쪽 다 하므로 증가 — 감내 상한 필요) ③ 프레임당 바이트 절감 예측치 ④ fair scheduler capability `accepted` 비율 |
| **이탈 조건** | **불일치 0건**을 목표 워크로드 전수에서. 축은 client `1/2/8` × session `1/8/32/54` (`05:561`) |
| **위험** | 사용자 노출 동작 변화 **없음**. `05:562` — *"가장 안전한 단계이므로 **여기서 최대한 오래 머문다**"* |

| 항목 | 내용 |
|---|---|
| **파일 위치** | `server/src/ws/binaryShadowParity.test.ts`(신규) · `frontend/src/utils/binaryFrameCodec.ts`(신규) · `frontend/tests/unit/binaryFrameCodec.test.ts`(신규, S2 골든 벡터 소비) |
| **검증 커맨드** | `npx tsx --test src/ws/binaryShadowParity.test.ts` (cwd=`server/`)<br>`node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts` (cwd=`frontend/`) |
| **회귀 커맨드** | `node --experimental-strip-types --test tests/unit/terminalOutputScheduler.test.ts tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` (cwd=`frontend/`) |
| **핀 영향** | **P1 · P2 · P3 · P4 · P5** — 전 계열 |
| **⚠️ P5 선행** | **S4 착수 *전*에** `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 로 현행 스케줄러를 새 baseline 으로 재고정한다 (`03:667`). 미조치 시 *"관련 작업 전부 RED"*(`03:775`) |

#### S4-e. 스케줄러 벤치마크 게이트 — 담당·수용 기준 (이전 판 §4 한 줄 → 승격)

이전 판은 P5 를 §4 표 한 줄로 두고 담당·단계 연결이 없었다. `03` §10 전체가 여기 들어와야 한다.

**정확 게이트 (숫자가 확정적이므로 tolerance 불필요, `03:686-693`)**

| 게이트 | 기대값 |
|---|---|
| bytes ingress 당 `TextEncoder.encode` 호출 | **0** |
| bytes ingress 당 **인코더 결과 할당** (`encoderResultAllocationCount`) | **0** (`03:682`) |
| output digest parity (baseline vs candidate) | 동일 |
| consumed bytes | 동일 |

> `03:682` — `terminalOutputScheduler.ts:254` 의 인코더 주입 심(`textEncoder?: Pick<TextEncoder,'encode'>`)이 열쇠다. *"`enqueueBytes` 로 들어온 ingress 는 이 심을 한 번도 건드리지 않아야 한다 — 즉 `encoderResultAllocationCount === 0` 이 그대로 정확 게이트가 된다. **지어낸 임계값이 아니라 0 이라는 확정값**."*
>
> ⚠️ 지표명 주의(`03:578`): `encoderResultAllocationCount`(**할당** 수)와 호출 수(`prefixLoopEncodeCount` 등)는 **별개 필드**다. 같은 말로 섞어 쓰지 않는다.

**통계 게이트**: paired bootstrap p95 delta 의 95% CI 상한 ≤ baseline p95 의 5%. ⚠️ `03:695` — **이 5% 는 measurement-noise tolerance 이지 product SLO 가 아니다** (`PERF-BGSTAB-009` AC-9).

**신규 마이크로벤치 — 소켓 ingress 구간** (`03:697-706`, **`03:697` 이 `[설계결정]` 마커를 달고 있다** — 합의된 사양이 아니라 `03` 의 판단이다): 기존 하네스는 **문자열 ingress 에서 시작**하므로 `JSON.parse` 를 측정 범위에 포함하지 않는다. 이번 전환의 이득 절반이 거기 있다.
- 대상 구간: `WebSocketContext.tsx:687` 파싱 ~ `TerminalView.tsx:1673` enqueue 직전
- 두 arm 의 **payload 바이트가 동일**해야 하며 digest 로 확인
- **⚠️ 경계 대조군 필수** (`03:705`): ANSI 이스케이프가 **없는 순수 ASCII 코퍼스**로도 돌린다. *"이스케이프 팽창이 없는 조건에서도 차이가 나오는지 봐야, 측정하고 있는 것이 정말 codec 비용인지 알 수 있다"*
- 배치: `frontend/tests/benchmarks/` (**Playwright 미수집**). 실행: `node --experimental-strip-types --test tests/benchmarks/<파일>` (cwd=`frontend/`)

**필수 정합성 RED 테스트 11건** — `03:708-722` 이 정본. 전건 필수:

`enqueue`에 `Uint8Array` 거부 / 멀티바이트 2프레임 분할 / **bytes 사이 비어있지 않은 string write 순서 뒤집힘 감지(최대 위험)** / 빈 string write 무영향 / length 초과 프레임 명시 수렴 / 배치 2프레임 순서 처리 / Blob 명시 거부 / **grace 버퍼 `chunk-cap-exceeded`**(`WebSocketContext.tsx:477`) / **스케줄러 `visible-output-overflow`**(`terminalOutputScheduler.ts:15`) — ⚠️ *"두 계층의 사유 문자열을 섞지 말 것"*(`03:720`) / 협상 회신 전 바이너리 프레임 비수용 / `visibleFlushBudgetBytes` < 코드포인트 폭 시 교착 없이 전진

---

### S5 — 회계 재벤치 + 증거 번들 재발행 → `binary-optin`

#### S5-a0. `encodedBytes` 도메인 전환 (JSON codec 측) ⚠️ **신설 — S5 의 첫 작업이며 재측정보다 앞선다** (4차 검증 H-1)

§3.1-B 가 확정한 것을 **여기서 실행**한다. `encodedBytes` 를 **codec 무관 본문(body) 바이트**로 전환한다 — 즉 **JSON 경로의 회계도 함께 바꾼다.** 이 단계 시작 시점에는 아직 와이어가 JSON 뿐이므로(opt-in 은 §S5-c 에서 켠다), **도메인 전환의 효과를 인코딩 전환과 분리해 단독 측정할 수 있다.**

| 항목 | 내용 |
|---|---|
| **변경 지점** | `wsSendPolicy.ts:598-611` `fairDeliveryBytes()` → `Math.max(1, Buffer.byteLength(input.payload, 'utf8'))`. floor 1 의 사유는 §3.1-B — ⚠️ **"원장의 순증" 이 아니라 "예산"** 이다 (5차 검증 M-1): 본문 0 delivery 가 `:701`/`:758` 예산을 전혀 쓰지 않고 lane 을 점유하는 구멍을 막는다. ACK duplicate/over-ACK 판정(**`:836`·`:837`**)은 **오늘 이미 `deliverySeq` 에만 의존**하므로 floor 와 무관하다. ⚠️ **줄 범위 표기 정정** (6차 검증 L-4): 이전 판의 `:836-838` 중 **`:838` 은 `ACK_OUT_OF_ORDER`** 이지 duplicate/over-ACK 가 아니다. 세 줄 모두 `deliverySeq` 만 보므로 주장 자체는 참이나, §3.1-B 표 3행이 `:836`·`:837` 로 정확히 적은 것과 표기를 맞춘다 |
| **실패 테스트 (ACK 정산)** | ⚠️ **같은 편집에서 두 번째 ACK(seq3)를 추가한다** (5차 검증 M-3). 현행 `:472-479` 는 새 lane 에 ACK 1회뿐이라 `creditedBytes`(델타, `:839-840`)와 `lane.creditBytes`(누적, `:843`)가 우연히 같아 **두 값을 혼동한 구현이 통과한다.** 두 번째 ACK 를 넣으면 `creditedBytes` 는 세 번째 delivery 분만, `creditBytes` 는 셋의 합이어야 한다 — 갈라지지 않으면 정산이 누적 식으로 구현된 것이다 |
| **실패 테스트 선행** | `FairTerminalDeliveryScheduler.test.ts` 의 크레딧 단정을 **본문 리터럴로 먼저 바꿔 red 를 확인**한다 — `:470` → 12, `:471` → 9, `:478`·`:479` 의 `expectedBytes` → 21. ⚠️ **S1 이 남긴 것은 맨 숫자 `131`/`128` 이 아니다** (5차 검증 L-2): §7 항목 1 주의 처방은 **손으로 적은 봉투 문자열 + `Buffer.byteLength(expectedWire1, 'utf8')`** 형태이고 131/128 은 그 옆 **주석에만** 나온다. **S5 에서 교체되는 것은 그 봉투 문자열 표현식 전체**이며, 그 교체가 도메인 전환의 가시적 증거다. 테스트에서 숫자 `131` 을 grep 해도 나오지 않는다 |
| **경계 대조군** | **본문이 0바이트인 delivery 의 `encodedBytes` 가 1** 이어야 한다. 0 이면 floor 가 안 붙은 것이고, **119**(= 전환 전 봉투값)면 도메인이 안 바뀐 것이다. **두 방향 모두 red 로 갈리는지 확인**한다. ⚠️ **"52" 를 쓰지 않는다** (6차 검증 L-2): 52 B 는 **바이너리 최소 유효 OUTPUT 프레임**(28 헤더 + 24 프롤로그, §4 S2-b F1)인데 **S5-a0 시점의 산출식은 `fairDeliveryBytes()`(JSON 봉투) 하나뿐**이라 52 가 될 경로가 없다 — 와이어 도메인 잔재다. 전환 전 실제 값은 **119 B** (직접 계산: `{"type":"output","sessionId":"session-a","data":"","connectionEpoch":"epoch-a","deliverySeq":1,"deliveryKind":"output"}` = 119자 전건 ASCII. §7 항목 1 주의 131 = 119 + `'한글-alpha'` 12 B, 128 = 119 + `'🙂-beta'` 9 B 와 정합). ⚠️ 119 도 `deliverySeq` 자릿수 의존이므로 **맨 숫자로 박지 말고 §7 항목 1 주의 "손으로 적은 봉투 문자열 + `Buffer.byteLength`" 형태를 쓴다** |
| **관측 동작 변화 ①** | **있다.** 같은 `creditWindowBytes` 에 더 많은 delivery 가 들어간다(§10.2 분해 기준 142 → 42 ≈ 3.38× `[추정]`). 그래서 S5-a 의 바이트 재측정이 **이 전환 뒤에** 와야 한다 — 전환 전 숫자로 재발행하면 아티팩트가 낡은 도메인을 고정한다 |
| ⚠️ **관측 동작 변화 ② — 범위 축소** | **본문 바이트가 `smallOutputBypassBytes`(`:703`·`:716`·`:738`) 임계 아래로 내려간다.** 40 B 청크 기준 봉투 ≈356 → 본문 40 이므로 **bypass 128 인 구성에서 판정이 뒤집힌다**(§5 S5-a #4 주). ⚠️ **그러나 뒤집힌 판정이 *실제 동작으로 드러나는* 지점은 셋 중 둘뿐이고, 그나마 `resolveFairTerminalDeliveryPolicy` 가 만드는 구성에서는 대부분 사문(死文)이다** (6차 검증 H-1, 직접 확인):<br>• **soft gate `:702-703` — 두 지정 구성 어디서도 발동하지 않는다.** `eligible()` 은 `:701`(`socketQueuedBytes + encodedBytes > creditWindowBytes` → false)을 **먼저** 통과해야 `:702-703` 에 도달하므로 그 시점에 항상 `socketQueuedBytes < creditWindowBytes` 다. 따라서 **`socketSoftGateBytes ≥ creditWindowBytes` 인 구성에서는 `:702` 가 항상 참**이고 `:703` 의 bypass 가지는 죽는다. 저한도 구성(`TerminalResourcePolicy.test.ts:1554-1557`)은 softGate **12,288** ≥ creditWindow **4,096**, 스키마 **기본값도** `serverBufferedHighWaterBytes` **8,388,608** ≥ `perClientOutputQueueMaxBytes` **2,097,152**(`config.schema.ts:122`·`:124`) — **둘 다 사문**이다. 살아나려면 `serverBufferedHighWaterBytes < perClientOutputQueueMaxBytes` 여야 하고 스키마가 그것을 금지하지는 않는다(`:127-135` 는 hard/high 관계만 본다)<br>• **deficit 대조 `:716-717` — 저한도 구성에서 판별력이 없다.** `:800` 이 `canSpendDeficit()` **전에** quantum 을 적립하고 그 값이 `bulkSliceBytes(256) × weight(visible 8 / driver 16)` = **2,048 또는 4,096**(`:706-712`, `TerminalResourcePolicy.ts:50`·`:54`)이라, 전환 전(356)·후(40) **어느 쪽도 `:717` 을 거짓으로 만들지 못한다**<br>• **deficit 차감 `:738-739` — 여기만 실제로 갈린다.** 전환 전 356 > 128 → `lane.deficitBytes -= 356`, 전환 후 40 ≤ 128 → 차감 없음<br>`[추정]` bypass 가 실제로 DRR 공평성을 약화시키려면 `bulkSliceBytes × weight < 본문 ≤ smallOutputBypassBytes` 가 성립해야 하는데, resolver 유도 정책에서는 quantum = `outputLimit/2`(visible) 또는 `outputLimit`(driver) 이고 bypass = `controlLimit/8` 이라 **`controlLimit > 4 × outputLimit` 인 구성에서만** 성립한다. ⚠️ **단 스키마 기본값(bypass 32768)에서는 봉투값 356 도 이미 임계 아래라 판정 뒤집힘 자체가 없다** — 이 위험은 **한도 구성 의존**이며, 그래서 §5 S5-a 가 요구한 *"재벤치 한도 구성을 먼저 고정"* 이 여기서도 전제다 |
| **실패 테스트 (② 전용)** | ⚠️ **저한도 구성으로는 쓸 수 없다 — 지정 구성과 지정 단정이 서로 배타적이었다** (6차 검증 H-1). 이전 판은 *"`TerminalResourcePolicy.test.ts:1553-1558` 과 같은 값에서 `socketQueuedBytes ≥ socketSoftGateBytes` 인 상태에서도 전송되는지"* 를 요구했는데, 그 구성에서 `socketQueuedBytes ≥ 12,288` 은 `:701`(`< 4,096` 요구) 때문에 **도달 불가**이고 도달했다면 본문 크기와 무관하게 전송되지 않아 **처치군·대조군이 같은 이유로 실패한다 = 판별력 0**. 대신 **정책을 직접 주입하는 하네스**를 쓴다 — `FairTerminalDeliveryScheduler.test.ts:132` `createPolicy(overrides)` / `:147` `createHarness(signature, { policy })` 는 resolver 를 거치지 않으므로 `socketSoftGateBytes < creditWindowBytes` 를 만들 수 있다(하네스 기본값이 이미 softGate **512** < creditWindow **2048**, `:135-142`).<br>**처방** `[설계결정]`: `createPolicy({ socketSoftGateBytes: { value: 64, source: policySource }, smallOutputBypassBytes: { value: 128, source: policySource } })`. ⚠️ **맨 숫자로 넘기면 컴파일되지 않는다** (7차 검증 L-1, 직접 확인): `SchedulerPolicy` 의 9개 필드가 전부 `{ value: number; source: string }` 이고(`FairTerminalDeliveryScheduler.test.ts:101-111`), 기본값도 같은 형태(`:133-143`)이며, 기존 호출부도 그 형태로 넘긴다(`:269`, `:380-386`). 나머지 하네스 기본값 유지 — `bulkSliceBytes` **128** × 가중치 = quantum **256** ≥ 129 이므로 deficit 이 개입하지 않아 **soft gate 축만 단독 관측**된다. ⚠️ **quantum 은 384 가 아니라 256 이다** (7차 검증 L-3, 직접 확인): 384 는 `visibilityWeight` 3 을 쓴 값인데 `deficitQuantum()`(`wsSendPolicy.ts:706-712`)은 `delivery.serviceClass === 'visible'` 일 때만 그 가중치를 쓰고, 하네스의 `enqueue({...})` 호출 관례는 `serviceClass` 를 넘기지 않으므로 `driverWeight` **2**(`:138-139`)가 적용된다. **결론(quantum ≥ 129 → deficit 미개입)은 256 에서도 그대로 성립**하므로 설계는 무해하고 수치만 정정한다.<br>• **처치군**: 본문 **40 B** output delivery 를 ACK 없이 연속 enqueue → **세 번째부터** `socketQueuedBytes`(80) ≥ softGate(64) 라 `:702` 가 거짓이 되지만 `:703` 이 `40 ≤ 128` 로 통과해 **계속 전송**된다. ⚠️ **한 칸 어긋나 있었다** (7차 검증 L-2, 직접 확인): 누적은 전송 **후**(`:727` `lane.socketQueuedBytes += delivery.encodedBytes`)이므로 **2번째 delivery 판정 시점의 `socketQueuedBytes` 는 40** 이고 `:702`(`40 < 64`)가 아직 참이다 — `:703` bypass 가지가 처음 필요해지는 것은 **3번째**(판정 시점 80)다. 전환 **전**에는 같은 40 B payload 의 `encodedBytes` 가 봉투값 ≈159 라 1번째 전송 후 `socketQueuedBytes = 159 ≥ 64` 이고 `159 ≤ 128` 이 거짓 → **첫 delivery 이후 정체**한다. **이 차이가 red→green 을 만든다**<br>• **경계 대조군 (129 B)**: 같은 구성에서 본문 **129 B** delivery 는 `129 ≤ 128` 이 거짓이라 `socketQueuedBytes ≥ 64` 이후 **정체해야** 한다. ⚠️ **인용 정정** (6차 검증 M-2): 이전 판은 이 대조군의 기전을 `:717` `lane.deficitBytes >= delivery.encodedBytes` 로 적었으나, `:800` 의 선(先)적립 quantum 이 129 보다 크므로 **`:717` 은 항상 참 = vacuous 대조군**이다. 129 B 에서 실제로 갈리는 것은 **`:703`**(위 처방) 또는 **`:738-739`**(deficit 차감) 둘뿐이다<br>• **`:738-739` 축을 따로 재려면**: `deficitBytes` 는 **`snapshot()` 이 노출하지 않는다**(`:882-899` — `queuedBytes`/`socketQueuedBytes`/`creditBytes`/`sentDeliverySeqs` 만). 사설 필드 캐스트로 읽지 말 것(메모리 `unchecked_private_field_casts_go_vacuous`). ⚠️ **그러나 이전 판의 대체 관측(*"전송이 지연되는 라운드 수"*, 본문 40 → 즉시 / 본문 65 → 여러 라운드)은 단일 lane 에서 vacuous 하다** (7차 검증 M-1, 직접 확인): `drain()` 의 `:812-814` `if (!selected) { if (waitingForDeficit) continue; break; }` 가 **같은 호출 안에서 quantum 을 반복 적립하며 재시도**하므로 65 B 도 결국 같은 `drain()` 안에서 전송되고, 라운드 수 카운터는 노출되지 않으며, `sentCount` 는 deficit 대기 라운드에 증가하지 않아(`:791`·`:817` 만 증가) `maxDeliveries`(`:775`)로도 드러나지 않고, `now` 는 drain 중 전진하지 않아 latency metric 도 동일하다 → **처치군·대조군이 같은 결과 = 판별력 0**(6차 M-2 와 같은 vacuity).<br>  **정정된 처방** `[설계결정]`: **경쟁 lane 을 하나 더 두고 `sent` 의 순서(round-robin 스킵)를 단정한다.** `createPolicy({ bulkSliceBytes: { value: 8, source: policySource }, visibilityWeight: { value: 1, source: policySource }, driverWeight: { value: 1, source: policySource }, smallOutputBypassBytes: { value: 64, source: policySource } })` → quantum ≡ **8**(`:706-712`, `serviceClass` 무관).<br>  &nbsp;&nbsp;— **lane A** (먼저 등록): 본문 **65 B** output 1건. `65 > 64` 이므로 `:716` 이 거짓이고 `:717` 이 `deficitBytes ≥ 65` 를 요구 → `:800` 이 라운드마다 8 씩 적립하므로 **9번째 라운드**(72 ≥ 65)에야 선택된다. 선택 후 `:738-739` 가 `deficitBytes -= 65` 를 실행한다 — **이 차감이 재려는 대상이다**<br>  &nbsp;&nbsp;— **lane B** (나중 등록): 본문 **40 B** output 여러 건(≥ 9). `40 ≤ 64` 라 `:716` 으로 즉시 spendable, `:738` 도 거짓이라 차감 없음<br>  &nbsp;&nbsp;— **단정**: 한 번의 `drain()` 뒤 하네스 `sent` 배열에서 **A1 앞에 B delivery 가 8건** 온다(`:794-811` 이 A 를 `:803` `continue` 로 스킵하고 B 를 선택 → `:808` 로 커서가 A 로 되돌아옴). 기존 테스트의 `sent.findIndex(item => item.connectionEpoch === … && item.sessionId === …)` 관례를 그대로 쓴다<br>  &nbsp;&nbsp;— **경계 대조군**: lane A 의 본문만 **64 B** 로 낮추면 `:716` `64 ≤ 64` 가 참이라 deficit 을 거치지 않고 **첫 라운드에 선택** → `sent` 가 A1, B1, A2 … 로 교대한다. **1 바이트 차이로 A1 의 인덱스가 8 → 0 으로 갈린다**<br>  &nbsp;&nbsp;— **교란 배제**: 정확한 건수는 `roundRobinCursor` 초기값 0 과 **lane 등록 순서(A 먼저)** 에 의존하므로 둘 다 테스트에서 고정한다. 또 `:701`·`:702`가 개입하지 않도록 전송 총량을 하네스 기본값(softGate **512** / creditWindow **2048**) 아래로 유지한다 — 위 구성의 누적은 8×40 + 65 = **385 < 512** |
| **핀 영향** | **P1**(`wsSendPolicy.ts`) · **P2**(`:47`). 저장 즉시 red → **republish** (§4 S0.5 절차) |
| **검증 커맨드** | `npx tsx --test src/ws/FairTerminalDeliveryScheduler.test.ts` (cwd=`server/`)<br>`npx tsx --test src/ws/WsRouterSendPriority.test.ts src/ws/wsSendPolicyRestoreMetadata.test.ts` (cwd=`server/`)<br>`npx tsx src/test-runner.ts` (cwd=`server/`) |
| ⚠️ **증거 재수집** | `PERF-BGSTAB-010` AC-5 원문(`30.*:3677`)은 *"실제 encodedBytes ledger"* 라고만 하고 도메인을 고정하지 않으므로 **AC 위반은 아니다.** 다만 그 REQ 의 검증 증거 중 **크레딧 수치에 의존하는 것**은 재수집 대상이다 `[추정]` — 착수 시 `get_requirement(id="PERF-BGSTAB-010")` 로 증거 목록을 직접 대조해 범위를 확정한다 |

#### S5-a. 재조정 임계값 — **9개를 다루되 처분은 5 + 3 + 1 로 갈린다** ⚠️ **전면 정정** (셈법은 5차 검증 M-2, 도메인 귀속은 5차 H-1)

⚠️ **이전 판의 "5개 전부(이전 판은 1개)" 는 셈법·함수·파일이 모두 틀렸다** (2차 검증 HIGH H-1). 그 목록은 **`02:265` 를 그대로 옮긴 것**인데 `02:265` 자체가 부정확하다. 직접 확인한 사실:

| 이전 판 주장 | 직접 확인한 사실 |
|---|---|
| *"`resolveFairTerminalDeliveryPolicy` 주입 임계값(`wsSendPolicy.ts:518-528`)"* | **`wsSendPolicy.ts:518-528` 은 함수가 아니라 `export interface FairTerminalDeliveryPolicy` 선언**이다 |
| 필드 5개 | **필드 9개** — `strategy`(`:519`) · `socketSoftGateBytes`(`:520`) · `bulkSliceBytes`(`:521`) · `smallOutputBypassBytes`(`:522`) · **`visibilityWeight`(`:523`)** · **`driverWeight`(`:524`)** · `creditWindowBytes`(`:525`) · **`ackTimeoutMs`(`:526`)** · `queueMaxBytes`(`:527`) |
| 함수 위치 | **`resolveFairTerminalDeliveryPolicy` 는 `server/src/services/TerminalResourcePolicy.ts:26`** 에 있고 반환형은 `FairTerminalDeliveryPolicyProjection`(`:14-24`)이다. 방출 키도 **9개**: `:36` `strategy` / `:37` `socketSoftGateBytes` / `:41` `bulkSliceBytes` / `:45` `smallOutputBypassBytes` / `:49` `visibilityWeight` / `:53` `driverWeight` / `:57` `creditWindowBytes` / `:61` `ackTimeoutMs` / `:65` `queueMaxBytes` |
| 완전성 | *"5개 전부"* 라는 **완전성 주장** 때문에 **4개(`strategy`·`visibilityWeight`·`driverWeight`·`ackTimeoutMs`)를 놓친 채 아티팩트를 재발행**하게 된다 |

**그리고 5개 목록은 이 계획이 같은 절에서 인용한 AC 원문과도 어긋난다.** `PERF-BGSTAB-010` AC-4 (`docs/spec/30.buildergate-stability.srs.md:3676`, 직접 인용):

> *"**Scheduling strategy, socket soft gate, bulk slice, small-output bypass, visibility/driver weight와 credit window**는 TerminalResourcePolicy field와 현재 authoritative evidence bundle의 policy/source digest에서 파생되어야 하며 …"*

**AC-4 가 명시하는 파생 대상은 7개**(strategy · socketSoftGate · bulkSlice · smallOutputBypass · **visibilityWeight** · **driverWeight** · creditWindow)다. 두 목록의 차이를 정확히 적으면:

| | 5개 목록(`02:265`) | AC-4 7개 | resolver 9개 |
|---|:--:|:--:|:--:|
| `socketSoftGateBytes` · `bulkSliceBytes` · `smallOutputBypassBytes` · `creditWindowBytes` | ✅ | ✅ | ✅ |
| **`strategy` · `visibilityWeight` · `driverWeight`** | ❌ **누락** | ✅ | ✅ |
| `queueMaxBytes` | ✅ | ❌ AC 미언급 | ✅ |
| **`ackTimeoutMs`** | ❌ **누락** | ❌ AC 미언급 | ✅ |

**→ 5개 목록이 실제로 놓친 것은 4개**(`strategy`·`visibilityWeight`·`driverWeight`·`ackTimeoutMs`)다. ⚠️ **`queueMaxBytes` 는 5개 목록에 들어 있다** — 이전 판이 *"AC 에 없는 `ackTimeoutMs`·`queueMaxBytes` 도 함께 놓쳤다"* 라고 쓴 것은 `queueMaxBytes` 에 대해 자기 앞 문장과 모순이었다 (3차 검증 M-1). `queueMaxBytes` 는 **"5개 목록에는 있으나 AC-4 에는 없는"** 유일한 키이고, `ackTimeoutMs` 는 **"둘 다에 없고 resolver 에만 있는"** 유일한 키다.

**S5 재벤치의 확정 대상 — 9개 전부**:

⚠️ **귀속 열을 "바이너리 전환 영향" 에서 "무엇이 값을 움직이는가" 로 바꾼다** (5차 검증 H-1). 이전 판은 #2·#3·#4·#9 를 여전히 *"직접 — 바이트 임계"* 로 **와이어 바이트 도메인**에 귀속시켜 놓고, 같은 절 말미의 귀속표(*"무엇이 창을 넓히는가"*, `01:732` 인용 아래)에서는 *"바이너리 인코딩 전환 = 0×"* 라고 스스로 적었다. **두 서술은 양립하지 않는다.**

**정본은 코드다** (전부 직접 확인, `server/src/ws/wsSendPolicy.ts`). 아홉 키 중 바이트 임계 다섯은 **전부 `delivery.encodedBytes` 와 비교**된다 — 와이어 프레임 크기가 아니다:

| 임계 | 비교식 |
|---|---|
| `creditWindowBytes` | `:701` `lane.socketQueuedBytes + delivery.encodedBytes > options.policy.creditWindowBytes.value` |
| `socketSoftGateBytes` · `smallOutputBypassBytes` | `:702-703` `lane.socketQueuedBytes < …socketSoftGateBytes.value \|\| delivery.encodedBytes <= …smallOutputBypassBytes.value` |
| `smallOutputBypassBytes` (deficit) | `:716-717` `delivery.encodedBytes <= …smallOutputBypassBytes.value \|\| lane.deficitBytes >= delivery.encodedBytes` |
| `smallOutputBypassBytes` (deficit 차감) | `:738` `delivery.kind === 'output' && delivery.encodedBytes > …smallOutputBypassBytes.value` |
| `queueMaxBytes` | `:758` `lane.queuedBytes + encodedBytes > options.policy.queueMaxBytes.value` |

그리고 누적 피연산자도 같은 도메인이다 — `:727` `lane.socketQueuedBytes += delivery.encodedBytes` · `:769` `lane.queuedBytes += encodedBytes` · `:724` shift 시 차감. **즉 §S5-a0 이 `encodedBytes` 를 본문 도메인으로 바꾸는 순간 다섯 임계의 피연산자가 전부 바뀌고, 그 이후의 JSON→바이너리 인코딩 전환은 이 다섯에 대해 0× 다** (두 codec 이 같은 본문 바이트를 세므로 — §3.1-B).

| # | 키 | 선언 | resolver | AC-4 명시 | 무엇이 값을 움직이는가 |
|---:|---|---|---|:--:|---|
| 1 | `strategy` | `:519` | `:36` | ✅ | **아무것도.** 값은 `'deficit-round-robin'` 고정이고 **decision artifact 의 candidate 귀속만 바뀐다** |
| 2 | `socketSoftGateBytes` | `:520` | `:37` | ✅ | **S5-a0 도메인 전환.** 피연산자는 `lane.socketQueuedBytes`(= Σ `encodedBytes`, `:727`)와 `delivery.encodedBytes`(`:702-703`) 둘 다 본문 도메인으로 이동한다. **바이너리 인코딩 전환 영향 0×**<br>⚠️ **그러나 이 키는 `socketSoftGateBytes ≥ creditWindowBytes` 인 구성에서 *동작에 아무 영향이 없다*** (6차 검증 H-1, 직접 확인). `:701` 이 `:702` 보다 먼저 판정하고 통과 조건이 `socketQueuedBytes + encodedBytes ≤ creditWindowBytes` 이므로 `:702` 도달 시 항상 `socketQueuedBytes < creditWindowBytes` → softGate 가 그보다 크거나 같으면 `:702` 는 **항상 참**이고 `:703` 의 bypass 가지는 죽는다. **저한도 회귀 구성**(softGate 12,288 ≥ creditWindow 4,096, `TerminalResourcePolicy.test.ts:1554-1557`)도 **스키마 기본값**(`serverBufferedHighWaterBytes` 8,388,608 ≥ `perClientOutputQueueMaxBytes` 2,097,152, `config.schema.ts:122`·`:124`)도 그 경우다. **재측정 자체는 여전히 필요하다**(AC-4 파생 요건) — 다만 **"이 키를 재측정해서 동작이 달라지는지 본다" 는 측정 설계는 그 두 구성에서 성립하지 않는다.** 관측하려면 `serverBufferedHighWaterBytes < perClientOutputQueueMaxBytes` 인 구성이거나 주입 하네스(§5 S5-a0 실패 테스트 행)를 써야 한다 |
| 3 | `bulkSliceBytes` | `:521` | `:41` | ✅ | ⚠️ **두 역할이 서로 다른 도메인이다 — 한 행으로 뭉개지 않는다** (5차 H-1):<br>**(a) DRR deficit quantum** `:706-712` `bulkSliceBytes.value × weight` → 대조 상대가 `delivery.encodedBytes`(`:717`), 적립은 **`:800`** `candidate.deficitBytes += deficitQuantum(delivery)` (⚠️ 이전 판의 `:801` 은 한 줄 어긋난 인용 — `:801` 은 `if (!canSpendDeficit(candidate, delivery))` 다. 7차 검증 L-4, 직접 확인. 같은 문서 line 1388·§14.0 M-2 행은 `:800` 으로 정확했다). **encodedBytes 도메인 → S5-a0 이 움직인다**<br>**(b) 배치 상한** `01:1401` `const limit = policy.bulkSliceBytes.value` → `01:1411` `while out.length < limit`. `out.length` 는 **와이어 바이트**(`01:1429` `byteLength: out.length`)이고 배치 조립기는 **바이너리 경로 전용**이다. **와이어 도메인 → 바이너리 인코딩 전환이 움직인다**<br>**두 역할을 따로 재측정한다.** (a) 는 S5-a0 직후 JSON 상태에서, (b) 는 `binary-optin` 이후에 |
| 4 | `smallOutputBypassBytes` | `:522` | `:45` | ✅ | **S5-a0 도메인 전환 — 판정이 뒤집힌다.** ⚠️ **원인·시점·여유 폭이 이전 판과 다르다 — 아래 #4 주** |
| 5 | **`visibilityWeight`** | `:523` | `:49` | ✅ | ⚠️ **아무것도** — 바이트가 아니라 무차원 비율이고 스키마 하한이 값을 8 로 고정한다(아래 주). 단 이 값은 **(3a) deficit quantum 의 승수**이므로 quantum 자체는 (3a)와 같은 도메인에서 움직인다 |
| 6 | **`driverWeight`** | `:524` | `:53` | ✅ | 동상 (고정값 16) |
| 7 | `creditWindowBytes` | `:525` | `:57` | ✅ | **S5-a0 도메인 전환 — 재측정이 선택이 아니라 필수다.** `:701` 의 두 피연산자가 모두 본문 도메인으로 이동해 실효 창이 §10.2 분해 기준 **≈3.38× 넓어진다** `[추정]`. **S5-a0 을 마친 뒤에 잰다** — 전환 전 숫자로 재발행하면 아티팩트가 낡은 도메인을 고정한다 (§3.1-B). **바이너리 인코딩 전환 영향 0×** |
| 8 | **`ackTimeoutMs`** | `:526` | `:61` | ❌ (AC-4 미언급) | **시간 도메인.** `:824` `now - (lane.lastServiceAt ?? now) >= …ackTimeoutMs.value` — 바이트를 보지 않는다. 값이 움직인다면 **프레임당 바이트 감소 → ACK 왕복 빈도 변화** 경로이며 `[추정]` 이다. **바이트 5개와 같은 처분을 적용하지 않는다** (5차 M-2) |
| 9 | **`queueMaxBytes`** | `:527` | `:65` | ❌ (AC-4 미언급) | **S5-a0 도메인 전환.** `:758`/`:769` 가 전부 `encodedBytes` 누적이다. **바이너리 인코딩 전환 영향 0×** |

> ⚠️ **#4 주 — `02:272` 의 "61B" 는 21B 초안 값이다. 단서 없이 인용하지 않는다** (3차 검증-B L-1, 직접 확인). `02:272` 원문은 *"40바이트 프롬프트 재출력 청크의 경우 JSON ≈ 300B vs 바이너리 **61B**"* 이고, `61 = 40 + **21**`(`02:270` *"바이너리 프레임 고정 오버헤드 = **21 바이트**"*)이다. §2.3 이 폐기한 초안 헤더다.
>
> **28B 확정안으로 재계산하면 `40 + 28 + 24(OUTPUT 프롤로그) = 92B`** 다. **`06` §10.3 이 이미 같은 40B 예시를 92B 로 재계산해 놓고**(`1 - 92/356 ≈ 74%`), **여기서는 `02:272` 를 무단서로 인용**해 두 절이 서로 다른 값을 쓰고 있었다.
>
> 🚫 **그러나 92 도 356 도 `smallOutputBypassBytes` 의 피연산자가 아니다** (5차 검증 H-1, 직접 확인). `:703` 과 `:716` 이 비교하는 것은 **`delivery.encodedBytes`** 이지 와이어 프레임 크기가 아니다. 92 B(바이너리 총 프레임)와 356 B(JSON 총 프레임)는 **`byteLength` 도메인**의 값이며 §10.3 의 절감률 산수에서는 계속 유효하되, **bypass 판정에 넣으면 안 된다.**
>
> ⚠️ **JSON 쪽 피연산자도 `356` 이어야 한다 — `≈300` 이 아니다** (4차 검증 L-1, 직접 확인). 3차-B 정정은 바이너리 쪽(61 → 92)만 고치고 JSON 쪽은 `02:272` 의 `≈300` 을 그대로 남겨, **정정 후에도 §5 S5-a 와 §10.3 이 같은 40B 예시에 서로 다른 JSON 크기를 쓰고 있었다.** 두 숫자는 서로 다른 것을 잰다:
>
> | 출처 | 값 | 무엇인가 |
> |---|---:|---|
> | **`02:267-268`** `[추정]` | **250~400 B** | **봉투 고정 오버헤드** — payload 크기와 무관한 부분. `02:272` 의 `≈300B` 는 이 값을 40B 청크의 **총 프레임 크기로 잘못 재사용**한 것이다 |
> | **`02:366`** `[추정]` | **356 B** | **40B 청크의 총 JSON 프레임** — 봉투 + 이스케이프 팽창 포함. §10.3 이 `1 - 92/356 ≈ 74%` 에서 쓰는 값 |
>
> **92 B(바이너리 총 프레임)와 대조할 올바른 피연산자는 `356`** 이다 — 층위가 같아야 한다.
>
> **"판정이 뒤집힌다" 는 결론은 유지된다. 그러나 원인·시점·여유 폭이 전부 바뀐다** (5차 검증 H-1). `TerminalResourcePolicy.test.ts:1553-1558` 의 튜닝 호출(control 1,024 → `smallOutputBypassBytes = 128`, 그 값을 `:1559-1577` 이 단정) 기준으로 **40 B 청크 하나**를 따라가면:
>
> | 시점 | `encodedBytes` 산출식 | 40B 청크의 값 | `≤ 128` ? |
> |---|---|---:|---|
> | **오늘** (봉투 도메인) | `fairDeliveryBytes()` = `createWsTransportMessage(...).byteLength` (`wsSendPolicy.ts:598-611` → `:91`/`:95`) | **≈356** `[추정]` (`02:366`) | ❌ bypass 안 됨 |
> | **S5-a0 직후** (본문 도메인, **아직 JSON**) | `Math.max(1, Buffer.byteLength(input.payload,'utf8'))` | **40** | ✅ bypass 됨 |
> | **S5-c `binary-optin` 이후** | 동상 — codec 무관(§3.1-B) | **40** | ✅ **변화 없음** |
>
> **즉 뒤집힘의 원인은 바이너리 인코딩 전환이 아니라 §S5-a0 의 도메인 전환이고, 시점은 아직 JSON 이 유일한 와이어 포맷일 때이며, 바이너리 전환의 추가 영향은 0× 다.** 여유 폭도 `92/128 ≈ 72%` 가 아니라 **`40/128 = 31.25%`** 다 — 임계까지 3배 이상 여유가 있으므로 *"청크가 조금만 커져도 임계를 넘는다"* 는 이전 판의 우려는 성립하지 않는다. 임계를 넘으려면 **본문이 128 B 를 넘어야** 한다.
>
> ⚠️ `92/128 ≈ 72%` 는 4차 검증이 *"재확인, 손대지 말 것"* 으로 지목했던 값이다. **그러나 재확인된 것은 92 와 356 의 산수였지, 그 둘이 bypass 판정의 피연산자라는 전제가 아니었다.** 5차에서 전제가 코드로 반증되었으므로(`:703`/`:716` 의 피연산자 = `delivery.encodedBytes`) 이 수치는 폐기하고 §14.2 의 do-not-touch 목록에서도 내렸다. **92 와 356 자체는 `byteLength` 도메인 값으로 §10.3 에서 계속 유효하다.**
>
> ⚠️ **그리고 이 뒤집힘은 스키마 기본값에서는 관측되지 않는다** `[추정]` — `config.schema.ts:125` `perClientControlQueueMaxBytes` **기본값 262144** 이면 `smallOutputBypassBytes = floor(262144/8) = **32768**` 이라 **봉투값 356 도 본문값 40 도 둘 다 임계 아래**다. **즉 "판정이 뒤집힌다" 는 튜닝된 저한도 구성의 성질이지 기본 배포의 성질이 아니다.** S5 재벤치는 **어느 한도 구성에서 재는지를 먼저 고정**해야 하며, 기본값에서만 재면 `smallOutputBypassBytes` 의 전환 영향이 **0 으로 관측**된다.

> ⚠️ **#5·#6 정정 — "#4 가 움직이면 같이 움직인다" 는 거짓이다. 단 불변성은 무조건이 아니라 조건부다** (3차 검증-B M-4). `TerminalResourcePolicy.ts:32-34`/`:49-56` 을 직접 읽고 계산했다. `smallOutputBypassBytes = max(1, floor(controlLimit / 8))` (`:34`) 이므로
> - **`visibilityWeight`**(`:49-51`) = `max(1, floor(controlLimit / smallOutputBypassBytes))`
> - **`driverWeight`**(`:53-55`) = `max(1, floor(outputLimit / max(1, outputLimit / 16)))` — ⚠️ **분모의 `outputLimit / 16` 은 floor 되지 않은 부동소수 나눗셈**이다(`:54` 원문 확인)
>
> **이전 판은 이 둘을 무조건 `≡ 8` / `≡ 16` 이라 서술했고 "직접 계산했다" 라벨까지 붙였는데, 그것은 항등식이 아니다.** 성립 조건과 반례:
>
> | 값 | 항등 조건 | 조건 밖의 실제 값 | 반례 |
> |---|---|---|---|
> | `visibilityWeight ≡ 8` | **`controlLimit ≥ 64`** | `L = 8q + r` 일 때 `8 + floor(r/q)` (`q = floor(L/8)`, `L < 8` 이면 `q=1` 이라 값이 `L`) | `L=20 → 10` · `L=27 → 9` · `L=15 → 15` · `L=7 → 7` |
> | `driverWeight ≡ 16` | **`outputLimit ≥ 16`** | `outputLimit` 자체 (분모가 `max(1, ·)` 로 1 에 걸리므로) | `outputLimit=10 → 10` |
>
> **그러나 두 조건은 실배포에서 항상 성립한다** (직접 확인). `config.schema.ts:124-125` 가 `bytesLimit(1024, …)` 로 **하한 1024** 를 강제한다 — `perClientOutputQueueMaxBytes` 기본 2,097,152 / `perClientControlQueueMaxBytes` 기본 262,144, **둘 다 최소값조차 1024 ≥ 64 이고 ≥ 16** 이다. 즉 **스키마가 통과시키는 모든 구성에서 8/16 이다.** 회귀 스위트의 호출값(`TerminalResourcePolicy.test.ts:1553-1558`: control 1,024 / output 4,096)도 조건을 만족하므로 아래 보강 지시의 기대 리터럴 `8`·`16` 은 정확하다.
>
> **→ 정확한 서술은 "바이트 한도를 어떻게 재튜닝해도 고정" 이 아니라 "`controlLimit ≥ 64` · `outputLimit ≥ 16` 에서 고정이며, `config.schema.ts:124-125` 의 하한 1024 가 그 조건을 보증한다" 이다.** 결론(재측정 대상에서 빼고 재귀속만)은 그대로 유효하되, **근거가 함수의 항등성이 아니라 스키마의 하한**이라는 점이 중요하다 — **하한이 낮아지면 결론이 무너지므로**, `config.schema.ts:124-125` 를 §5 S5-a 의 전제로 기록해 둔다.
>
> 둘 다 **바이트 값이 아니라 무차원 비율**이다. 이전 판의 "간접이지만 실재 — 같이 움직인다" 는 파생 관계만 보고 값의 불변성을 놓친 것이고, 그 정정판은 반대로 조건을 놓쳤다.
>
> **그럼에도 9개를 다 도는 이유는 바뀐다**:
> - **#5·#6 은 값이 아니라 `source` 귀속 때문에 포함된다.** AC-4(`30.*:3676`)가 *"TerminalResourcePolicy field 와 현재 authoritative evidence bundle 의 policy/source digest 에서 파생"* 을 요구하므로, 값이 그대로여도 **재발행된 아티팩트에 다시 실려야** 계약이 성립한다. 빠뜨리면 AC-4 위반이지 수치 오류가 아니다
> - **#1 `strategy`** 도 같은 성격 — 값은 `'deficit-round-robin'` 고정이나 **provenance 문자열**(`'fair-scheduler-decision.json#candidate'`, `:36`)이 새 generation 을 가리켜야 한다
> - **실제로 값이 움직이는 것은 #2·#3·#4·#7·#9 다섯 개**(전부 바이트). ⚠️ **그중 #3 은 두 역할이 서로 다른 도메인이므로 재측정도 두 번**이다 — (a) deficit quantum 은 S5-a0 직후 JSON 상태에서, (b) 배치 상한은 `binary-optin` 이후에 (5차 검증 H-1)
> - **#8 `ackTimeoutMs` 는 어느 쪽도 아니다** — 시간 도메인이라 재귀속으로 끝나지 않고(값이 움직일 수 있다), 그렇다고 바이트 5개와 같은 도메인 전환 재측정 대상도 아니다. **영향은 `[추정]` 이며 재측정 범위에는 넣되 별도 항목으로 둔다** (5차 검증 M-2)
>
> **귀결**: S5 는 "9개 재측정" 이 아니라 **"바이트 5개 재측정(#3 은 두 역할 각각) + 비율/문자열 3개(`strategy`·`visibilityWeight`·`driverWeight`) 재귀속 + 시간 1개(`ackTimeoutMs`) 재측정 범위 포함 `[추정]`"** 이다.
>
> ⚠️ **이전 판의 "5 + 4" 셈법은 `ackTimeoutMs` 를 "비율/문자열 4개" 에 밀어 넣은 것인데, 그것은 비율도 문자열도 아니다** (5차 검증 M-2). 4차 M-3 이 "9개" 지시를 고치면서 같은 편집으로 이 오류를 만들었고, §5 S5-a #8(*"재측정 범위에는 넣는다"*)·§13 층 B(세 번째 줄로 분리)와 셋이 서로 달랐다. **`5 + 3 + 1` 이 세 곳의 공통 정본**이다. 이 구분을 아티팩트 재발행 체크리스트와 §5 S0-c 의 AC 저작 문면에 그대로 반영한다.

`01:732` — *"바이너리는 같은 내용을 훨씬 적은 바이트로 표현하므로, **숫자를 그대로 두면 실효 창이 내용 기준으로 몇 배 커진다. 백프레셔가 늦게 걸리고 슬로우 클라이언트 격리가 약해진다.**"*

⚠️ **이 인용은 전제가 기각된 문단에서 온다 — 그 사실을 함께 적는다** (3차 검증-B HIGH). **`01:732` 는 `01:728`(= `encodedBytes` 를 프레임 전체 길이로 재정의) 의 파급을 열거한 문단**이다(`01:730` *"이 변경의 파급이 크므로 명시한다:"* 바로 아래 1번 항목). **§3.1-A 가 `01:728` 을 기각했으므로, 전제를 버리고 귀결만 인용하면 논거가 공중에 뜬다.**

⚠️ **그리고 이전 판의 대체 논거는 §4.2 와 정면 모순이었다** (4차 검증 H-1). 이전 판은 *"본문-only 쪽이 **창 확대 폭이 더 크고** … 백프레셔가 늦게 걸린다 는 **더 강하게 성립**한다"* 라고 적었다. **창이 확대된다 = 같은 내용의 크레딧 소모량이 인코딩 전환 전후로 달라진다** 인데, §4.2 는 바로 그 본문-only 채택 사유를 *"`05:204` 의 A안이 요구하는 **인코딩 불변**"* 이라 못 박았다. 두 서술은 양립할 수 없다. 원인은 문서가 **JSON codec 의 `encodedBytes` 를 규정하지 않아**, 암묵적으로 *JSON = 봉투 포함 / 바이너리 = 본문-only* 라는 **codec 별 도메인**을 전제하고 있었다는 것이다.

**§3.1-B 가 그 공백을 메웠다. 그 위에서 논거를 다시 세운다** — 결론(S5 재벤치 필수)은 유지되고 **귀속이 바뀐다**:

| 무엇이 창을 넓히는가 | 언제 | 폭 |
|---|---|---:|
| **`encodedBytes` 도메인 전환** (봉투 → 본문, **두 codec 공통**) | **S5, 아직 JSON 상태에서** | §10.2 분해 기준 **142 → 42 ≈ 3.38×** `[추정]` — 42바이트 원본이 JSON 프레임에서 142바이트를 차지하므로 |
| **JSON → 바이너리 인코딩 전환** | S5-c(`binary-optin`) 이후 | **0×** — 두 codec 이 같은 본문 바이트를 세므로 **크레딧 산수가 변하지 않는다.** 이것이 `05:204` 의 "인코딩 불변" 이 요구한 상태이며 `01:728` 기각 사유의 실체다 |

⚠️ **이 표가 위 9키 표의 귀속과 일치해야 한다** (5차 검증 H-1). 4차 판까지는 이 표가 *"인코딩 전환 = 0×"* 라 적어 놓고 같은 절의 9키 표는 #2·#3·#4·#9 를 *"직접 — 바이트 임계"* 로 **와이어 도메인에 귀속**시켜 서로 반대를 말했다. 코드가 정본이며(`wsSendPolicy.ts:701`·`:702-703`·`:716-717`·`:738`·`:758` 이 전부 `delivery.encodedBytes` 와 비교), 9키 표를 이 표에 맞춰 정정했다. **이후 둘 중 하나를 고치면 반드시 나머지도 같이 고친다.**

**즉 `01:732` 가 경고한 *"실효 창이 몇 배 커진다 / 백프레셔가 늦게 걸린다"* 는 참이되, 그 원인이 `01:728` 이 지목한 인코딩 전환이 아니라 도메인 전환이다.** 재벤치 필요성은 **약해지지도 강해지지도 않는다 — 시점이 앞당겨진다.** `creditWindowBytes` 재측정은 opt-in 이 켜지기 전, **JSON 상태에서** 수행해야 한다.

**이것이 오히려 측정 설계상 유리하다**: 도메인 전환의 효과를 **인코딩 전환과 분리해 단독 측정**할 수 있다. 두 변화를 한꺼번에 켜면 §5 S5-c 가 경고한 *"바이너리 전환의 효과가 아니라 다른 것을 측정하는"* 함정에 그대로 걸린다. **이 방향으로 `PERF-BGSTAB-011` 근거를 저작한다**(§3.1-B 지시 4).

⚠️ **프롤로그-only(본문 0) 프레임은 floor 1 로 계상된다** — §3.1-B. 재벤치 워크로드에 그런 프레임이 섞이면 크레딧 소모가 프레임 수의 하한으로만 반영되므로, **두 도메인이 각각 프레임 수 상한을 준다**는 사실을 측정 해석에 반영한다 — ① `encodedBytes` 도메인의 `creditWindowBytes`(`:701`)·`queueMaxBytes`(`:758`)가 floor 1 덕분에 delivery 수를 묶고, ② `byteLength` 도메인이 와이어 바이트로 묶는다. ⚠️ **이전 판의 *"프레임 수 상한이 `byteLength` 도메인 소관"* 은 5차 L-6 이 §3.1-B 표·S0 지시 3 에서 정정한 배타적 문면이 이 줄에만 남아 있던 것이다** (6차 검증 M-1) — **어느 쪽이 먼저 걸리는지는 두 설정 키의 상대 크기에 달렸고 스키마가 그 관계를 제약하지 않는다**(§3.1-B 0B 처분 표 3행, 6차 H-3). ⚠️ **그리고 ②를 `serverBufferedHardLimitBytes` 백프레셔 게이트(`WsRouter.ts:6098-6099`)로 지목하는 것은 `wsSendMode` 종속이다** (7차 검증 H-1, 직접 확인) — 기본값 `'direct'`(`config.schema.ts:201`)에서는 `:6086-6094` 의 early return 때문에 그 게이트가 **평가되지 않고**, `byteLength` 도메인 상한은 출력 큐 쪽(`:6169`·`:6182`, 상한값은 `:6158` → `:5761-5763` `perClientOutputQueueMaxBytes`)에서 온다. **즉 재벤치 한도 구성을 고정할 때 `wsSendMode` 도 함께 고정·기록해야 한다** — 모드가 다르면 ②의 피연산 키 자체가 달라진다. **측정 해석에서도 어느 한쪽을 실효 상한으로 가정하지 말고, 재벤치 구성에서 모드와 두 값을 실제로 확인한 뒤 판단한다.**

⚠️ **`PERF-BGSTAB-010` AC-4 파생 규칙**: 새 정책 상수 도입 금지(`01:397`, `01:477`). 재튜닝은 기존 **9개** 값의 **재측정**이지 새 상수 추가가 아니다. AC-3(`docs/spec/30.buildergate-stability.srs.md:3675`)이 decision artifact 에 `workload schema/config hash` 와 metric 별 threshold 를 고정하도록 요구하므로 **숫자를 바꾸려면 재벤치와 아티팩트 재발행이 필요**하다(`01:733`).

⚠️ **부수 발견 — 정책 타입이 두 벌이다** (직접 확인, `[설계결정]` 대상): `FairTerminalDeliveryPolicy`(`wsSendPolicy.ts:518`)와 `FairTerminalDeliveryPolicyProjection`(`TerminalResourcePolicy.ts:14`)이 **구조적으로 동일**하고(후자는 `readonly` + `T extends number | string` 제약), `FairTerminalDeliveryPolicyValue<T>` 도 **두 곳(`wsSendPolicy.ts:513`, `TerminalResourcePolicy.ts:9`)에 선언**되어 있다. **§10.2(중복 아키텍처 금지) 위반 후보**다. **다만 이번 범위 밖이므로 발견 사실만 보고하고 통합하지 않는다** — S5 는 값을 재측정할 뿐 타입을 건드리지 않는다.

**검증 커맨드** (cwd=`server/`): `npx tsx --test src/services/TerminalResourcePolicy.test.ts`

⚠️ **이 스위트는 키 집합을 단정하지 않는다 — 그리고 빠진 3개가 정확히 위에서 놓쳤던 3개다** (3차 검증 H-2, 직접 확인). 이전 판은 *"resolver 가 방출하는 키 집합을 이 스위트가 직접 단정한다(`:1544`, `:1552-1553`)"* 라고 적었으나 실제 내용은 다르다:

| 줄 | 실제 내용 |
|---|---|
| `:1542` | `test('PERF-BGSTAB-010 AC-4 fair delivery policy projection is derived from typed WS resource limits', …)` |
| `:1544-1549` | **타입 선언**(`resolveFairTerminalDeliveryPolicy?: (limits: {…}) => Record<string, {value, source}>`) — 단정이 아니다 |
| `:1552` | `assert.equal(typeof policy.resolveFairTerminalDeliveryPolicy, 'function', signature)` — **함수 존재 여부만** |
| `:1553-1558` | 호출(`perClientOutputQueueMaxBytes: 4_096`, `perClientControlQueueMaxBytes: 1_024`, …) |
| **`:1559-1577`** | **유일한 값 단정 — `deepEqual` 이 덮는 키는 6개**: `socketSoftGateBytes`(12,288) · `bulkSliceBytes`(256) · `smallOutputBypassBytes`(128) · `creditWindowBytes`(4,096) · `queueMaxBytes`(4,096) · `ackTimeoutMs`(5,000) |
| `:1578` | `Object.values(projection).every(v => v.source.length > 0)` — **모든 키를 훑지만 `source` 가 빈 문자열이 아닌지만** 본다. 값도, 키 이름도, 개수도 안 본다 |

**→ `strategy` · `visibilityWeight` · `driverWeight` 는 어느 단정에도 걸리지 않는다.** AC-4 가 명시적으로 파생을 요구하는 7개 중 **3개가 회귀 게이트 밖**이라는 뜻이고, 공교롭게도 이전 판의 5개 목록이 놓친 것과 **같은 3개**다. 두 누락이 독립 사건이 아니라 **같은 사각지대**를 가리킨다.

**[설계결정] S5 는 재측정에 앞서 이 스위트를 먼저 보강한다** — §7 에 항목 9 로 등재한다:
1. `deepEqual` 대상에 `strategy.value` · `visibilityWeight.value` · `driverWeight.value` 를 추가 (기대값 `'deficit-round-robin'` · `8` · `16` — 위 주의 불변성이 **리터럴로 고정**된다)
2. **키 집합 자체를 단정**: `assert.deepEqual(Object.keys(projection).sort(), [...9개].sort())` — 키가 늘거나 줄면 red. 현재는 resolver 에 키를 추가해도 아무 테스트도 깨지지 않는다
3. `source` 는 `length > 0` 이 아니라 **리터럴 대조**로 — `PERF-BGSTAB-010` AC-4 가 요구하는 것은 "빈 문자열이 아님" 이 아니라 "TerminalResourcePolicy field 에서 파생됨" 이다

⚠️ **이 보강은 §S2-a 의 "출처가 같으면 vacuous" 원칙을 지켜야 한다** — 기대값을 `resolveFairTerminalDeliveryPolicy` 를 다시 호출해 만들면 안 되고, **리터럴로 적는다**(메모리 `check_operands_must_have_independent_origins`).

#### S5-b. `retainedStateDigest` 계약 파단면

`TerminalAuthorityProductionAdapter.ts:1740-1750` 이 **`parserTail.data`(= base64 문자열)** 를 digest 입력에 포함한다(`02:380`). 인코딩을 바꾸면 **digest 정의가 바뀌어 구/신 클라이언트가 서로 다른 값을 계산**한다. digest 입력을 원본 바이트로 재정의해야 하며 **이는 계약 변경**이다.

반면 `TerminalAuthorityProductionAdapter.ts:1659` 의 checkpoint digest 는 **원본 문자열** 기준(`createHash('sha256').update(data,'utf8')`)이라 **무관**하다(`02:381`).

#### S5-c. 사다리: `binary-optin`

**동작** (`05:566-574`): capability 로 바이너리를 선언한 클라이언트에만 바이너리 전송. **기본 클라이언트는 선언하지 않는다.**

| 항목 | 내용 |
|---|---|
| **진입 조건** | shadow 이탈 조건 충족 · §S6 매트릭스 M1~M4 통과 |
| **측정** | ① 화면 정합성(구멍/깨짐 0) ② downgrade 건수·사유 분포 ③ echo p50/p95/p99 (JSON 대조군 대비) ④ **CPU 프로파일 — 서버·브라우저 분리**(`03:726`: `JSON.stringify` 는 Node, `JSON.parse` 는 브라우저. 섞으면 귀속 불가) ⑤ ACK credit 원장 정합성 |
| **이탈 조건** | 정합성 결함 0 + downgrade 가 전부 **의도된 사유**로 설명됨 + echo 회귀 없음 |
| **위험** | opt-in 사용자만. 롤백 = 선언 중단 |

⚠️ **단계 전이 시 반드시 확인** (`05:596`): **fair scheduler 가 여전히 붙어 있는지.** P1 때문에 핀 파일을 만질 때마다 스케줄러가 조용히 떨어질 수 있고, 그 상태에서 성능을 재면 *"바이너리 전환의 효과가 아니라 **스케줄러 부재**를 측정하게 된다."* 확인 방법: capability 응답의 `accepted` 와 `reason` 을 직접 읽는다.

| 항목 | 내용 |
|---|---|
| **검증 커맨드** | `node tools/wave3/fair-scheduler-decision.test.mjs` (루트, 벤치마크 실행)<br>`npx tsx --test src/benchmarks/terminalFairnessCharacterization.test.ts src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts` (cwd=`server/`)<br>`node tools/wave3/terminal-resource-consumer-manifest.test.mjs` (루트) |
| **핀 영향** | **P1**(필수 재발행) · **P2** |

---

### S6 — 혼합 버전 + 롤백 드릴 → `binary` 기본값 전환

#### S6-a. 혼합 버전 — 새 하네스 불필요

`perfBgstab010Ac6BrowserAckHarness.ts:58` 이 브라우저 안에서 **원시 `new WebSocket(...)`** 을 열고 `:100-105` 에서 capability 를 **직접 선언**한다. capability 는 설정이 아니라 **클라이언트가 보내는 메시지**이므로 **한 브라우저에서 버전 혼합이 가능하고, split 소켓을 켤 필요가 없다** — `REL-BGSTAB-006` AC-5 제약을 우회한다(`05:495-508`).

⚠️ **재사용 제약 2건** (이전 판 누락):

| # | 제약 | 근거 |
|---|---|---|
| 1 | 복사하지 말고 **공용부를 추출**하되, *"그 하네스는 `frontend/tests/unit/perfBgstab010Ac6ServerAckFaultContract.test.ts` 가 **소스 텍스트로 고정**하고 있으므로 리팩터 시 그 정규식이 계속 만족되는지 확인"* | `05:526` |
| 2 | 하네스 자신의 파서 3곳(`:45`, `:129`, `:191`)이 **silent-drop 지점**이다 — S3 에서 처리 | `05:173` |

**매트릭스 M1~M6** 은 `05:512-521` 이 정본. **§7.5 관측 하한 단정 필수** — *"이것 없이는 M1~M4 가 전부 vacuous 하게 통과한다. 구버전 프로브가 아무것도 못 받아도 'silent drop 이 없었다' 는 참이기 때문"*(`05:533`).

#### S6-b. 롤백 드릴 — **R1~R7 전건** (이전 판은 4건 누락)

이전 판은 R2·R5·R6·**R7** 을 빠뜨렸다. `05:619-627` 이 정본:

| ID | 시나리오 | 단정 |
|---|---|---|
| R1 | N 프레임 전송 후 롤백 트리거 | **새 `connectionEpoch`** 부여. 이전 ≠ 새 |
| **R2** | 롤백 직후 **이전 epoch 의 바이너리 프레임 도착** | **거부** + 관측 가능한 프로토콜 오류. `PERF-BGSTAB-010` AC-8 |
| R3 | 큐에 바이너리 K개 잔존 | 큐가 **버려진다.** JSON 으로 재인코딩되어 나가지 **않는다** |
| R4 | 롤백 후 첫 프레임 | `screen-snapshot`(JSON), `mode`/`seq` 가 **fresh** |
| **R5** | 롤백 후 **화면 내용** | 롤백 직전 논리 화면과 **동등.** 마커 문자열 전부 보임 |
| **R6** | **ACK credit 원장** | held bytes / timer / queue 가 **정확히 한 번** 해제. `PERF-BGSTAB-010` AC-8 |
| **R7** | **경계 대조군 — 롤백을 트리거하지 않음** | **R1~R6 의 단정이 전부 실패해야 함** |

> `05:629` — *"**R7 이 핵심이다.** 롤백 테스트가 통과했다는 것만으로는 롤백을 측정했다는 증거가 아니다 … 롤백을 안 걸었는데도 같은 단정이 통과하면, 그 단정은 롤백이 아니라 세션 생성이나 재연결 일반을 재고 있었던 것이다."*
>
> ⚠️ **이전 판은 S1·S2 에는 경계 대조군을 요구하면서 S6 에는 요구하지 않았다 — 내부 모순이다.** 같은 원칙(메모리 `boundary_control_for_fault_tests`)이 세 곳에 동일하게 적용된다.

**순서 규정** (`01:1047`): 상태 전이도 ②(`codecEpoch = E+2`)가 ③(큐 폐기)보다 **먼저** 와야 한다. *"순서가 바뀌면 폐기와 재개 사이에 새 프레임이 구 epoch 으로 들어온다."* 전체 8단계는 `01:1013-1044` 가 정본.

**3중 방어** (`01:1063-1084`): 타입(보장 1) → `codecEpoch` 런타임 게이트(보장 2, `WsRouter.ts:6249`) → 클라이언트 `stale-stream-epoch`(보장 3, `terminalWriteCoordinator.ts:1127-1130` — **가장 바깥이 이미 구현되어 있다**).

**트리거 4종은 단일 롤백 함수로 수렴** — D5 (§3.2).

#### S6-c. 사다리: `binary` 기본값 전환

| 항목 | 내용 |
|---|---|
| **진입 조건** | opt-in 이탈 조건 · 롤백 드릴이 **자동 테스트로 반복 통과** · `#21`(default flip) 절차 |
| **이탈 조건** | **두 릴리스 soak** — *"외부 시간, 개발 속도로 앞당길 수 없음"*(`05:583`) |
| **위험** | 설정 안 건드린 전 사용자. **`.strict()` 함정**: 설정 스키마가 바뀌었으면 구 빌드로 롤백해도 설정을 못 읽는다 (§4.1) |

| 항목 | 내용 |
|---|---|
| **파일 위치** | 신규 `server/src/ws/WsRouterBinaryRollback.test.ts`(`05:617`) · 신규 `frontend/tests/e2e/binary-mixed-version.spec.ts`(`05:525`) · 신규 `frontend/tests/support/legacyJsonClientProbe.ts` · (권장) `frontend/tests/e2e/binary-rollback-drill.spec.ts`(`05:633`) |
| **검증 커맨드** | `npx tsx --test src/ws/WsRouterBinaryRollback.test.ts` (cwd=`server/`)<br>`npx playwright test tests/e2e/binary-mixed-version.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`)<br>**`npx playwright test tests/e2e/perf-bgstab-010-ac6-server-ack-fault.spec.ts --project "Desktop Chrome"`** (cwd=`frontend/`)<br>`node --experimental-strip-types --test tests/unit/perfBgstab010Ac6ServerAckFaultContract.test.ts` (cwd=`frontend/`) — 하네스 소스 텍스트 고정 확인 |
| ⚠️ 주의 | project 3종(`Desktop Chrome`/`Mobile Safari`/`Tablet`)을 다 돌면 **3배**다. 기존 `test:e2e:*` 스크립트가 전부 `--project "Desktop Chrome"` 로 고정된 이유(`05:528`) |
| **핀 영향** | **P1 · P2** |

---

### S7 — legacy JSON 경로 제거 (범위 밖, 참고)

진입 조건: 단계 3 이탈(두 릴리스 soak) + `#22` 조건. **`#22` 는 "코드가 다 준비됐다" 만으로 닫을 수 없다 — 달력상 두 릴리스가 실제로 지나야 한다**(`05:591`).

**범위 주의**: JSON **control 평면은 제거 대상이 아니다.** 제거 대상은 output/snapshot 의 JSON 인코딩 경로뿐(`05:592`). 그리고 `03:744` — 클라이언트의 JSON 수신 경로는 downgrade 용으로 **영구 존치**한다.

---

## 6. capability 협상 — 단계로 편입 (이전 판은 단언만)

이전 판은 *"capability 협상으로 활성화한다"* 고 단언만 하고 어느 단계에서 무엇을 만드는지가 없었다. `01:595-691` 은 **2계층** 협상을 규정한다.

### 층 1 — subprotocol (소켓 스코프) — S3

```js
new WebSocket(url, ['buildergate.v1.binary', 'buildergate.v1.json'])
```
두 생성 지점 모두 subprotocol 인자를 쓰지 않는다(`WebSocketContext.tsx:1201`, `:1007` — 직접 확인). **인자 추가가 전부다**(`01:619`). 서버는 `WebSocketServer` 생성 시(`WsRouter.ts:612`) `handleProtocols` 를 준다.

⚠️ **이 배정은 §5 S3 의 작업 목록에 실려 있어야 한다** (3차 검증-B L-8). 이전 판은 여기서 S3 소관이라 선언만 하고 §S3 상세의 파일 위치·검증 커맨드·핀 영향 어디에도 항목을 두지 않아, **S3 담당자가 §6 을 읽지 않으면 통째로 누락**되는 구조였다. 특히 **`WsRouter.ts:612` 는 P1 핀 파일**이라 누락은 곧 republish 누락이다. → **§5 S3 의 "subprotocol 협상" 소절이 정본이고, 이 절은 왜 2계층인지만 설명한다.**

이 층이 필요한 이유: **디코더 능력은 소켓 스코프**여야 한다 — terminal payload 가 output → control 소켓으로 폴백하므로 **control 소켓도 바이너리를 해독할 수 있어야** 한다(`01:601`). 그리고 RFC 6455 가 안전한 다운그레이드를 보장한다(`01:616`).

### 층 2 — in-band (그룹 스코프) — S4

**신규 메시지 — 인터페이스 5개 / distinct `type` 문자열 4개**(`01:637` 서술, 정의 `01:638-690`). 이름과 **요청/응답 type 공유 여부**가 함께 **D10 미해결**이다: `01` 은 `terminal-binary:*`, `02:594` 는 `terminal-encoding:capability`. 셈법과 `01` 내부 모순은 §3.3 D10 주 참조.

**이전 판이 빠뜨린 필수 규정**:

| 항목 | 근거 | 내용 |
|---|---|---|
| **송신 시점** | `01:718` | 바이너리 제안은 **`connected` 수신 후, `subscribe` 전** |
| **accept 응답이 `channels[]` 를 실어야 함** | `01:691` | *"협상은 `connected` 수신 뒤에 일어나는데, 그 시점에 이미 `subscribe` 가 나가 있을 수 있다 — 실제로 **`WebSocketContext.tsx:1227-1230` 이 `onopen` 에서 기존 구독을 일괄 재전송**한다. 초기 테이블이 없으면 그 세션들의 **첫 바이너리 프레임이 미지 channelId** 가 된다"* |
| **필수 플래그 협상** | `01:75-93` | `MANDATORY_FLAGS = 0x0009`(bit0 `END_OF_BATCH` + bit3 `PROLOGUE_PRESENT`), v1 `activeFlagMask = 0x000B`. 클라이언트 `acceptedFlagMask` 가 MANDATORY 를 빼면 **`mandatory-flag-not-accepted` 로 협상 실패** |
| **그룹 전체 동의 + 활성화 유예** | 채택안 **`01:860`** `[설계결정]` / 기각안 **`01:861`** | split 그룹은 **짝(output attach) 완성까지 BINARY 활성화를 유예**한다(`:860`, 유예 상한은 `pairTokenExpiresAt` 30초 = `WsRouter.ts:1690`). **즉시 활성화 후 강등 안의 기각은 `:861`** — *"강등이 예외가 아니라 기본 경로가 된다"* (2차 검증 L-8 — 이전 판은 기각을 `:860` 에 귀속시켰다). `unified` 는 소켓이 하나라 즉시 활성화(`:862`) |
| **모든 실패 경로가 응답을 보낸다** | `01:788` | §7 M-4 참조 |
| **거절 사유를 반드시 기록** | `01:790` | 현재 `terminal-delivery:capability` 의 `reason` 을 프론트가 **읽지도 로깅하지도 않는다**(`WebSocketContext.tsx:1023-1031`) |
| **promotion 게이트와 독립** | `01:585-593` | codec 협상은 `MIG-BGSTAB-002` AC-1 의 promotion 게이트에 **들어가지 않는다.** 넣으면 *"JSON 클라이언트 한 명이 붙어 있다는 이유로 authority promotion 이 차단"* 된다 |

---

## 7. 먼저 고쳐야 할, 이미 깨져 있는 것들

바이너리 작업이 이것들 위에 올라가면 **green 이 무의미해진다.**

| # | 항목 | 위치 | 상태 · 담당 단계 |
|---|---|---|---|
| 1 | ACK credit 단정이 vacuous | `FairTerminalDeliveryScheduler.test.ts:470-471` (credit 단정은 **`:478-479`**) | `:470` `assert.equal(sent1.encodedBytes, firstWireBytes, …)` 는 **`encodedBytes` 단정**이고, ACK credit 단정은 `:478` `assert.deepEqual(ack, {accepted:true, creditedBytes: expectedBytes})` · `:479` `creditBytes` 다 (2차 검증 L-14 — 취지는 동일). **구현과 기대를 같은 함수**(`encodedOutputBytes()` `:213-227`)에서 뽑는 것이 결함이며 `:467-469` 가 그 계산이다 → 인코딩을 바꿔도 초록. **독립 출처 기대값으로 교체.** ⚠️ **`05:213` 의 예시는 값도 도메인도 틀렸다 — 그대로 베끼면 S1 이 즉시 red 다** (4차 검증 H-2). 아래 주가 단계별 도메인·리터럴·코드 형태를 보유한다. **S1** (그리고 §3.1-B 도메인 전환 시 **S5 에서 한 번 더 교체**) |
| 2 | 타입 변경이 안 잡힘 | `FairTerminalDeliveryScheduler.test.ts:7-23` | 타입을 import 하지 않고 **재선언**(`02:197`). *"하지 않으면 이후 모든 타입 변경이 조용히 통과"*(`02:530`). **S1 (최선행)** |
| 3 | **스케줄러 벤치가 RED** | `terminalOutputSchedulerBenchmark.test.ts:79` | P5. 고정 candidate 가 HEAD·워킹트리 어디에도 없다. **기록된 `264.6ms → 2.61ms` 를 현재 성능으로 읽으면 안 된다**(`03:653`). **S4 착수 전 재고정** |
| 4 | 인증 신원 미구현 | `WsRouter.ts:1567` | `FR-BGSTAB-006` AC-3 의 "authenticated identity" 검사가 없다. 검증된 JWT payload 를 `_authPayload?: unknown` 으로 받아 **버린다**(`01:1128`). **split 단계 선행** |
| **5** | **바이트 임계에 UTF-16 length 사용** | `benchmarks/terminalFairnessCharacterization.ts:1093` | `creditPayload.length` 로 바이트 임계를 계산한다 — **이미 잠재 결함**(`02:205`). 위험 **높음**, **P1 재발행 유발**(`02:529`). **S5** |
| **6** | **소스 텍스트 매칭은 회귀 게이트가 아니다** | `benchmarks/terminalFairnessCharacterization.test.ts:162` | `assert.match(source, /createWsTransportMessage/u)` — *"**문자열 매칭이라 시그니처가 바뀌어도 통과한다. 이 축은 회귀 게이트로 신뢰할 수 없다**"*(`02:208`). ⚠️ 반대로 **`createWsTransportMessage` 를 개명하면 직접 깨진다**(`05:287`). **S1** |
| **7** | **split-shadow 에서 payload 유출** | `WsRouter.ts:5843` | 전송 대상 선택이 **mode 를 보지 않고 `group.output` 존재만 본다** → shadow 에서 payload 가 output 으로 샌다. `01:1157` — *"**바이너리 도입 전에 고쳐야** 계약과 런타임이 일치한다"*. `[추측]` 런타임 재현 못 함. **split 단계 선행 (#9)** |
| **8** | **응답 없이 반환하는 협상 가드** | `WsRouter.ts:1927-1929` (`handleTerminalDeliveryCapability`) | 파싱 실패 시 **아무 응답도 보내지 않고 return** → 클라이언트가 `accepted:false` 조차 못 받고 **영원히 대기**. `01:788` — *"**바이너리 협상에서 같은 구조를 복제하면 안 된다**"*. **S4 (§6 층 2)** |
| **9** | **`PERF-BGSTAB-010` AC-4 정책 키 3개가 회귀 게이트 밖** | `TerminalResourcePolicy.test.ts:1559-1577` | `deepEqual` 이 **6개 키만** 덮고 **`strategy`·`visibilityWeight`·`driverWeight` 는 어느 단정에도 안 걸린다**. `:1578` 은 `source.length > 0` 만 본다. **키 집합 단정 자체가 없어 resolver 에 키를 추가·삭제해도 red 가 안 난다.** AC-4(`30.*:3676`)가 명시적으로 파생을 요구하는 7개 중 3개가 무방비 (3차 검증 H-2, 직접 확인). **S5 재측정 *전*에 보강** — 상세는 §5 S5-a 말미 |

> ⚠️ **항목 1 의 리터럴 기대값 — `05:213` 은 숫자도 틀렸고 도메인도 틀렸다. 도메인 쪽이 치명적이다** (2차 검증 M-10 + **4차 검증 H-2**).
>
> **(1) 숫자 오류** (2차 M-10, 유지). `05:212-214` 의 예시
> ```
> assert.equal(sent.encodedBytes, Buffer.byteLength('한글-alpha', 'utf8')); // == 13
> ```
> 에서 실제 값은 **12** 다: `한`(3) + `글`(3) + `-`(1) + `alpha`(5) = 12. 주석의 `13` 이 산수 오류다.
>
> **(2) 도메인 오류 — 이전 판이 놓친 것.** 이전 판은 위험을 이 오타에 한정하고 *"리터럴은 실측 바이트로 직접 계산해 넣는다. `'한글-alpha'` → **12**, `'🙂-beta'` → **9**"* 라고 처방했다. **그 처방대로 S1 에서 `:470`/`:471` 을 12/9 로 바꾸면 테스트가 처음부터 실패한다.** 대상 단정이 세는 것은 **payload 바이트가 아니라 JSON 봉투 전체 바이트**이기 때문이다 (직접 확인):
>
> | 위치 | 코드 |
> |---|---|
> | `FairTerminalDeliveryScheduler.test.ts:467` | `const firstWireBytes = encodedOutputBytes('epoch-a','session-a',seq1,'한글-alpha');` |
> | `:213-227` `encodedOutputBytes` | `return createWsTransportMessage({ type:'output', sessionId, data: payload, connectionEpoch, deliverySeq, deliveryKind:'output' }).byteLength;` |
> | `:470` / `:471` | `assert.equal(sent1.encodedBytes, firstWireBytes, signature);` / `sent2 …, secondWireBytes` |
> | 구현측 (같은 도메인) | `wsSendPolicy.ts:598-611` `fairDeliveryBytes()` → `createWsTransportMessage(...).byteLength` → `:91` `JSON.stringify` / `:95` `Buffer.byteLength(payload,'utf8')` |
>
> **`05:213` 예시 자체가 `encodedBytes` 를 payload 바이트로 오인했고, 06 이 그 전제를 승계했다.** 이것은 §3.1-B(JSON codec 의 `encodedBytes` 가 규정되지 않았던 문제)와 **같은 뿌리**다.
>
> **처방 — 단계마다 도메인이 다르므로 리터럴도 두 번 바뀐다** `[설계결정]`:
>
> | 단계 | `encodedBytes` 도메인 | `'한글-alpha'` | `'🙂-beta'` |
> |---|---|---:|---:|
> | **S1** (JSON 상태, **관측 동작 불변** — §5 S1 제목) | **JSON 봉투 전체** (현행) | **131** | **128** |
> | **S5** (§3.1-B 도메인 전환 이후) | **본문(body) 바이트** | **12** | **9** |
>
> **S1 의 131 / 128 산출 근거** (직접 계산): 봉투는 `{"type":"output","sessionId":"session-a","data":"<payload>","connectionEpoch":"epoch-a","deliverySeq":<n>,"deliveryKind":"output"}` 이고 `screenSeq`·`authorityEpoch`·`authorityRevision`·`chunkId` 는 `undefined` 라 `JSON.stringify` 가 생략한다. ⚠️ **분해 서술 정정** (5차 검증 L-3 — **결과 131/128 은 정확하고 분해만 틀렸다**): 이전 판의 *"ASCII 부분 127자"* 에서 **127 은 ASCII 문자 수가 아니라 봉투 문자열의 총 문자 수**이고, **ASCII 문자는 125 자**다. 정확한 분해:

| 봉투 | 총 문자 | ASCII 문자 | 비-ASCII | 합 |
|---|---:|---:|---|---:|
| `'한글-alpha'`, `deliverySeq: 1` | 127 | **125** | `한`·`글` = 3 B × 2 = 6 B | 125 + 6 = **131** |
| `'🙂-beta'`, `deliverySeq: 2` | 125 (UTF-16 code unit 으로는 126 — `🙂` 가 서로게이트 쌍) | **124** | `🙂` = 4 B | 124 + 4 = **128** |

(이전 판의 *"127 + 초과분 4"* 도 총 문자 수를 1 B 로 세고 `한`·`글` 의 **초과분** 2 B × 2 를 더한 것이라 산술 결과는 같다. 두 셈법을 섞어 *"ASCII 부분 127자 + 초과분 4"* 라 적은 것이 오류다.)
>
> ⚠️ **131/128 은 `deliverySeq` 자릿수에 의존한다.** 새 하네스라 `seq1=1`·`seq2=2` 이지만 이것은 **런타임 값**이므로 맨 숫자로 박으면 하네스 변경에 조용히 깨진다. **처방: 기대 봉투 문자열을 손으로 적고 그 `Buffer.byteLength` 를 쓴다.**
> ```ts
> // 독립 출처: 기대 와이어 봉투를 손으로 적는다 (createWsTransportMessage 를 재호출하지 않는다)
> const expectedWire1 =
>   `{"type":"output","sessionId":"session-a","data":"한글-alpha",` +
>   `"connectionEpoch":"epoch-a","deliverySeq":${seq1},"deliveryKind":"output"}`;
> assert.equal(sent1.encodedBytes, Buffer.byteLength(expectedWire1, 'utf8'), signature); // == 131 when seq1 === 1
> ```
> 이렇게 하면 **두 피연산자의 출처가 갈린다**(손으로 적은 봉투 vs 프로덕션 인코더) — §S2-a 와 메모리 `check_operands_must_have_independent_origins` 의 요건을 만족하면서, **봉투 스키마가 바뀌면 red** 가 된다. 이전 판의 vacuity(구현과 기대가 같은 함수에서 나옴)를 깨는 목적이 그대로 달성된다.
>
> **S5 에서 이 단정을 12 / 9 로 바꾸는 편집이 §3.1-B 도메인 전환의 가시적 증거다.** 그 편집이 없으면 도메인이 안 바뀐 것이다 — 체크리스트 항목으로 둔다(§13 층 B).
>
> ⚠️ **`'🙂-beta' → 9` 에 `[추정]` 을 달지 않는다** (4차 검증 L-2). UTF-8 인코딩은 결정적이다: `U+1F642` = 4B, `-` = 1B, `beta` = 4B → **9**. 같은 문장의 `'한글-alpha' → 12` 를 확정으로 쓰면서 이쪽만 추정으로 두는 것은 근거 없는 비대칭이었다. (본문-only 도메인에서의 값이므로 **S5 행에만 적용**된다.)
>
> 그리고 **리터럴 옆에 계산 근거를 주석으로 남긴다** — 근거 없는 매직 넘버는 다음 사람이 다시 `encodedOutputBytes(...)` 로 되돌려 vacuity 를 재도입한다.

---

## 8. SRS Scope Boundaries 패치 — 라벨 정정

이전 판은 *"Scope Out-of-Scope 패치 5건"* 이라 했다. **5건 중 Out of Scope 를 건드리는 것은 2번(`30.*:27`)과 4번(`40.*:27`)뿐이다.** 나머지 3건은 다른 섹션이다 (`04:379-443`):

| # | 대상 | 섹션 |
|---|---|---|
| 1 | `30.buildergate-stability.srs.md` (line 23 뒤) | **In Scope 항목 추가** |
| 2 | `30.*:27` | Out of Scope 개정 |
| 3 | `30.*` (line 35 뒤) | **Assumptions and Constraints 항목 추가** |
| 4 | `40.mcp-session-orchestration.srs.md:27` | Out of Scope 개정 |
| 5 | `40.*` | **Assumptions and Constraints 항목 추가** |

**패치 1 이 왜 필요한가** (`04:394`): *"§8.3 상 scope 의 요구사항은 **In Scope 로 덮여 있어야 한다.** 신규 REQ 4건이 걸릴 자리를 만든다."* — 즉 1번은 부수적 정리가 아니라 **신규 REQ 4건의 전제조건**이다.

**도구 공백**: `append_section_note` 는 REQ 범위 전용이고 `scaffold-scope` CLI 는 이 버전에 없다(`04:40-44`). → **사용자 명시 승인(Q1) 후 수동 SRS-MD 패치**로만 가능. Requirement ID·Status·Stability 를 건드리지 않으므로 금지 3항에 저촉되지 않는다(`04:375`).

**검증**: 패치 직후 `npx speckiwi validate --json` → `byCode` 델타 0 (특히 `SRS-W018` 불변). **증가하면 즉시 되돌린다**(`04:484`).

---

## 9. 테스트 영향 요약 — 분류 정정

**좋은 소식 — 이음매가 좁다.** 서버 소켓 write 1곳(`WsRouter.ts:6268`, 직접 확인) / 브라우저 디코드 1곳(`WebSocketContext.tsx:687`). 덕분에 `frontend/tests/unit/` 56개 중 **38개가 자동으로 무관**하다 — 디코드 이음매 **아래**에서 이미 파싱된 객체를 받기 때문이다(`05:225`).

⚠️ 단 **서버 인코드 측은 1곳이 아니다** (§S4-a 7개 지점).

**나쁜 소식 — 조용히 깨지는 쪽이 더 많다.** 이전 판의 2행 표는 `05` 분류를 왜곡했다.

| 부류 | 수 | 실패 방식 | 정본 |
|---|---:|---|---|
| 서버 Mock (`JSON.parse` throw) | 8종 | **요란하게** 실패. 안전 | `05:132-139` |
| **⚠️ 예외: `WsRouterSendPriority.test.ts`** | 1 | **시그니처만 넓혀선 안 되는 유일한 케이스** — **와이어 문자열 부분매칭** `:961-968` (`payload.includes('must-not-drain-after-unsubscribe')`). 디코더가 필요하다 | `05:134` |
| **`test-runner.ts` 문자열 부분매칭** | 2 | `:15252` `JSON.stringify(sent[0]).split(snapshotMarker)`, `:15430` | `05:132` |
| 브라우저 · E2E 조용한 폐기 | **5** | `if (typeof data !== 'string') return;` → 타임아웃 또는 **vacuous green** | `05:171-175` |
| 프론트 프로덕션 코드 | **1** | `WebSocketContext.tsx:688-690` — **테스트가 아니라 제품** | `05:170` |
| 서버 node:test | **1** | `WsRouterRestoreMetadata.test.ts:110-117` — **테스트도 브라우저도 아님** | `05:176` |
| **서버 프로덕션 코드** | **1** | **`WsRouter.ts:1745`** — `JSON.parse` 실패 → `console.warn` 후 return. **`05` 표에 없다.** 이 계획이 추가 | §5 S3 |

> ⚠️ 이전 판의 *"브라우저·E2E 7곳"* 은 세 범주를 뭉갠 것이다. 실제 브라우저/E2E 는 **5곳**이고, 나머지는 프론트 프로덕션 1 + 서버 node:test 1 이다.
>
> **합계 정리** (2차 검증 H-2): **`05:170-176` 정본 = 5 + 1 + 1 = 7.** **이 계획의 S3 대상 = 7 + 서버 프로덕션 1 = 8.** 이전 판은 이 표를 7 로 분해하면서 §S3·§S4-d·§13 에서는 8 이라 써 **`WsRouter.ts:1745` 가 어느 범주에도 속하지 않는 채 사라졌다.** 위 4행이 8 을 남김없이 덮는다.

**요란하게 깨지는 Playwright spec 5개** (`05:140-144`): `wave3-terminal-authority-fairness.spec.ts`(`parseFrame :202-204`, output `:1574`) · `wave3-terminal-authority-promotion.spec.ts`(`:303-305`) · `wave2-screen-repair-resync.spec.ts`(`:103`) · `wave2-terminal-restore.spec.ts`(`:83-89`) · `perf-bgstab-010-ac9-isolated.spec.ts`(`:130-132`)

⚠️ `03:761` — 이 spec 들을 방치하면 *"전환 후 **스펙이 downgrade 경로만 검증**하게 되어 바이너리 회귀를 못 잡는다."* → 바이너리 주입 헬퍼를 추가하거나 JSON downgrade 경로로 **명시 고정**한다.

**S3 의 일부로 포함**: 프레임 필터를 쓰는 **모든** 기존 테스트에 관측 카운트 하한 단정(`assert.ok(observedOutputFrames > 0)`)을 추가한다(`05:481`).

---

## 10. 측정 — 산수 정정

**저장소에 JSON codec 실측치가 없다.** `#19` 의 "3%" 는 *프로파일링이라는 행위를 설명하는 예시*이지 실측치가 아니다 — **인용 금지**(`03:535`).

### 10.1 ⚠️ "봉투 250~400B → 28B" 는 이중 오류

| 이전 판 서술 | 정정 |
|---|---|
| "봉투 250~400B" | **연구 문서 어디에도 250–400 이 확정치로 없다.** `03:552-557` 은 **78B 고정**(봉투 리터럴 42 + sessionId 36), `01:552` 는 **약 200B `[미확인]`**, `02:268` 이 250~400 이지만 **`02:267` 에 `[추정]` 마커가 붙어 있다.** 이전 판은 마커를 탈락시켰다 |
| "→ 28B" | **자신의 프롤로그 채택(§1.2)을 무시한 값이다.** `01:552` — 28 B(헤더) + 24 B(OUTPUT 프롤로그) = **52 B** (+ 세그먼트 **16 B × N**) |

**이것이 S5 재벤치와 "무수정" 주장의 근거 산수다.** 28 이냐 52 이냐는 **`byteLength`(와이어) 도메인의 모든 산수**에 걸린다 — §10.3 절감률, `WsRouter.ts:6098-6099` 백프레셔 게이트가 묶는 프레임 수, `01:1401`/`01:1411` 배치 상한(`out.length`)이 한 WS 메시지에 담는 프레임 수. ⚠️ **단 `:6098-6099` 게이트는 `wsSendMode` 종속이다** (7차 검증 H-1, 직접 확인) — 기본값 `'direct'`(`config.schema.ts:201`)에서는 `:6086-6094` 가 `:6097` 이전에 early return 하므로 그 게이트가 평가되지 않고, 그 모드에서 프레임 수를 묶는 것은 출력 큐 상한(`:6169`·`:6182`; 상한값 `:6158` → `:5761-5763` `perClientOutputQueueMaxBytes`)이다. **둘 다 피연산자가 `byteLength` 이므로 28/52 산수가 걸린다는 사실 자체는 세 모드 모두에서 유지되고**, 바뀌는 것은 *어느 키가 그 상한을 주는가* 뿐이다.

🚫 ⚠️ **`smallOutputBypassBytes` 판정과는 무관하다 — 이전 판의 서술은 와이어 도메인 잔재였다** (6차 검증 H-2, 직접 확인). `:703` `delivery.encodedBytes <= …smallOutputBypassBytes.value` 와 `:716` 의 피연산자는 **`delivery.encodedBytes`**(S5-a0 이후 본문 바이트)이므로 **프레임 고정비 28/52 는 bypass 판정에 한 바이트도 들어가지 않는다.** 이것은 같은 문서 §5 S5-a #4 주가 *"92 도 356 도 `smallOutputBypassBytes` 의 피연산자가 아니다"* 로 이미 폐기한 바로 그 추론이며(5차 검증 H-1), §10.1 에만 잔존해 있었다. **bypass 판정을 움직이는 것은 §S5-a0 의 도메인 전환 하나뿐이고, 프레임 고정비의 영향은 0 이다.**

### 10.2 ⚠️ "3.38× — 142B 부가" 는 오독

`03:548-557` 의 분해를 직접 읽으면:

| 구성요소 | 바이트 |
|---|---:|
| 봉투 리터럴 `{"type":"output","sessionId":"","data":""}` | 42 |
| `sessionId` 값 (uuidv4) | 36 |
| **이스케이프된 `data` 필드** (원본 42 → 64) | 64 |
| **합계** | **142** |

**142 는 42바이트 원본의 *전체* JSON 프레임**이다. 그래서 142/42 = **3.38×** 다. 이전 판처럼 "142B **부가**" 라 하면 (42+142)/42 = **4.38×** 가 되어 자기 숫자와 모순된다.

같은 이유로 **"이스케이프 64B" 는 오버헤드가 아니다** — 이스케이프된 `data` 필드의 **총량**(42→64)이다. 순 증가분은 22B 다.

`03:557` — **봉투 오버헤드 78바이트(42+36)는 payload 크기와 무관한 고정비**이므로 작은 청크일수록 비율이 커지고, **큰 청크에서는 이스케이프 팽창(이 예에서 42→64, 약 1.52×)이 지배**한다.

`03:559` **`[추정]`** — *"실 워크로드의 평균 팽창률은 이스케이프 밀도와 청크 크기 분포에 의존하며 **저장소에 분포 데이터가 없다.**"*

### 10.3 ⚠️ "checkpoint 25% vs 라이브 72~83%" 는 귀속이 뒤집혔다

⚠️ **아래 수치는 전부 `[추정]` 이다.** `02:357` 이 절 제목 자체를 **`### 5.2 절감량 추정 [추정]`** 으로 달아 `:359-368` 전체에 마커를 부착했고, `02:359` 의 전제(*"바이너리 프레임 = 원본 + **21B**"*)도 그 안에 있다. **이전 판은 §10.1 에서 *"`02:267` 에 `[추정]` 이 붙어 있다. 이전 판은 마커를 탈락시켰다"* 라고 지적해 놓고, 바로 이 표에서 자기가 같은 탈락을 저질렀다** (2차 검증 H-3). 아래 표는 **마커를 복원한 상태**다.

`02:361-368` 의 원표를 직접 읽으면 — **전부 `[추정]`**:

| 대상 | 절감 `[추정]` | 비고 |
|---|---:|---|
| checkpoint chunk (64 KiB) | **25.2%** `[추정]` (`02:363`) | base64 제거가 지배. 계산 근거 `65,536 + **21**` |
| 2 MiB snapshot 전체 (32 chunk) | **≈28.6%** `[추정]` (`02:364`) | 이전 판 누락 |
| 라이브 output 청크 100 B | **≈72%** `[추정]` (`02:365`) | 계산 근거는 `100 + **21**` (21B 초안 헤더) |
| 라이브 output 청크 40 B | **≈83%** `[추정]` (`02:366`) | `40 + 21 = 61` |
| **범위 서술** | **70~85%** `[추정]` (`02:368`) | |

**세 가지 정정**:
1. 범위는 "72~83%" 가 아니라 **`02:368` 이 명시한 70~85%** 다
2. **원인 귀속이 반대다.** `02:368` — *"큰 blob 에서는 **base64 제거(25%)**가, 작고 잦은 라이브 프레임에서는 **JSON 봉투 제거(70~85%)**가 지배적이다."* 이전 판은 전체를 "base64 절감"으로 라벨해 귀속을 뒤집었다. **라이브 output 은 애초에 base64 가 아니다** — `screen-snapshot` 도 raw ANSI string 이다(`02:384`)
3. 그리고 **28B 확정안으로 재계산되지 않았다** — 위 수치는 전부 21B 초안 기준이다(§2.3). ⚠️ **"(또는 프롤로그 포함 52B)" 를 표 전체에 일괄 적용하면 안 된다** (3차 검증-B L-2, 직접 확인): **52 = 28 + `0x01 OUTPUT` 프롤로그 24B**(`01:488`)이므로 **라이브 output 두 행(`02:365`, `:366`)에만** 적용된다. 나머지 행의 기준은 opcode 별로 다르다

| 대상 행 | opcode | 프롤로그 | **프레임 고정비** |
|---|---|---:|---:|
| checkpoint chunk 64 KiB (`02:363`) | `0x05 CHECKPOINT_CHUNK` | **12 B** (`01:522`) | **40 B** |
| 2 MiB snapshot (`02:364`) | `0x02 SCREEN_SNAPSHOT` | 24 B (`01:516`) | 52 B |
| 라이브 output 100 B / 40 B (`02:365`, `:366`) | `0x01 OUTPUT` | 24 B (`01:488`) | 52 B |

   **재계산 결과**: 40B 청크의 절감은 **`1 - 92/356 ≈ 74%`** `[추정]` — `02:366` 의 83% 와 9pt 차이다. checkpoint chunk 행은 프레임 고정비가 40B 라 64 KiB 대비 무시할 수준이고, 그 행의 25.2% 는 **거의 전부 base64 제거분**이므로 헤더 재계산의 영향이 실질적으로 없다 `[추정]`. **어느 쪽이든 S5 재벤치 전에는 인용하지 않는다**

### 10.4 압축 대조군

⚠️ **`perMessageDeflate` 가 꺼져 있다** — ws 서버 생성은 `WsRouter.ts:612` `new WebSocketServer({ noServer: true })` 한 곳이고 옵션은 `noServer` 뿐이며 ws v8 기본값이 `false` 다(`01:546`). 전후 비교에는 **deflate-JSON 대조군**이 반드시 포함되어야 한다. 없으면 "바이너리가 빨랐다"가 아니라 **"압축을 안 켰었다"** 를 측정하게 된다(`01:558`).

그리고 `01:560` — deflate 를 켜면 백프레셔 계산이 깨진다: `ws.bufferedAmount`(`WsRouter.ts:6572-6576`)는 **압축 후** 바이트인데 `message.byteLength`(`wsSendPolicy.ts:95`)는 **압축 전** 바이트다.

### 10.5 근거 있게 말할 수 있는 것 — **횟수와 복잡도**

`03:596-604` 가 정본. output 메시지당 `JSON.parse` 1회 → 0, 전체 payload `TextEncoder.encode` 1회 → 0, 바이트 길이 조회 O(n) → **O(1)**, `sourceSegments` encode+decode 왕복 → `subarray` N회(복사 0), checkpoint `atob`+바이트당 `charCodeAt` 루프 → 뷰 1개.

⚠️ **`03:590`** — baseline↔candidate 차이(262 ms)로 "encode 1회당 비용" 을 **역산해서는 안 된다.** *"이 역산은 사실처럼 보이는 오류이므로 명시적으로 배제한다."*

⚠️ **`03:580`** — `trialCount` 는 **3** 이다. 표본 3개의 p95 는 사실상 **최댓값**이며 *"절대 성능 특성으로 일반화할 수 없다."*

### 10.6 서버 origin 제약

`SessionManager.ts:1353` `ptyProcess.onData((rawData: string))` — node-pty 가 **이미 문자열로 디코딩해서** 넘긴다. 따라서 **클라이언트 이득은 온전하지만 시스템 전체의 "복사 없음"은 자동으로 오지 않는다**(`03:612-616`). node-pty Buffer 모드 전환 여부는 별도 결정(`03:806` #9).

---

## 11. 조건부 · 후속 (범위 명시)

| 항목 | 처분 | 근거 |
|---|---|---|
| **`fullCheckpoint.chunks` 디코드 부재** | **바이너리 전환 이전에 삭제 후보 판정 필요.** 프론트 어디에서도 디코드하지 않는데 서버는 **`WsRouter.ts:5090-5093` 에서 `fullCheckpoint: fresh.fullCheckpoint` 즉 객체 전체를 보낸다** — ⚠️ 이전 판은 이를 *"`fullCheckpoint.chunks` 를 전송"* 이라 좁혀 적었으나 코드가 싣는 것은 `chunks` 필드가 아니라 **`fullCheckpoint` 객체 그 자체**다(`:5090` `checkpointAuthority: 'server-full-retained-state'` 와 함께, 2차 검증 L-12). 따라서 삭제 후보 판정 단위도 필드가 아니라 **이 객체 전체**다 — dead payload 이면 base64 전체를 헛되이 나르는 것 | `02:391-393` `[미확인]` |
| **`PERF-BGSTAB-009` AC-7** | ⚠️ **이전 판이 `02` 를 뒤집었다.** `02:419` — *"이 방향과 정합한다. **개정 없이 진행 가능**"*, `02:695` — *"**개정 불필요**(현행 유지와 정합)"*. AC 원문(*"Production ingress는 string을 유지하고 scheduler-to-xterm 구간만 …로 확장한다. 이 Requirement는 binary WebSocket 을 변경하지 않는다"*)은 **그 요구사항에 대한 범위 한정절이지 금지가 아니다**(`04:51`, `04:180-182`). → **미해결 목록에서 내린다.** 1단계 ingress 는 string 을 유지하므로 충돌 자체가 없다 | `02:419`, `02:695`, `04:51` |
| `terminalCheckpointRuntime.ts:408-418` `decodeBase64` | S5 이후 제거 후보 | `03:767` |
| 입력(브라우저→서버) 평면 | **범위 밖.** `webSocketBackpressure.ts` 무변경 | `03:382`, `02:413-420` |
| `Mobile Safari` / `Tablet` project 의 ArrayBuffer 수신 | `[미확인]` — 현재 이 두 project 를 도는 스크립트가 없어 **기준선 자체가 없다** | `05:736` U6 |

---

## 12. CI

현재 **테스트를 0건 돌린다.** `.github/workflows/` 아래 워크플로는 **`release.yml` 1개**이고, 트리거는 **태그 push(`'v*.*.*'`, `'*.*.*'`) + `workflow_dispatch`** 다(`release.yml:3-8`, 직접 확인) — ⚠️ 이전 판의 *"태그 push 전용"* 은 `workflow_dispatch`(`:8`)를 빠뜨린 것이다 (2차 검증 L-20). **`pull_request`·`schedule` 트리거는 없다.** lint/typecheck 0, pre-commit 훅은 `process.exit(0)` no-op (`05:656-666`).

> `workflow_dispatch` 가 있다는 사실은 실무상 의미가 있다: **Tier 0 워크플로를 새로 만들지 않고 수동 트리거로 먼저 시험해 볼 수 있다.** 단 `release.yml` 은 릴리스 빌드이므로 **`ensureBuildArtifacts()` → server build 를 타고, 그러면 P1 게이트에 걸린다**(§S-1 그룹 5 주의와 같은 함정). Tier 0 는 별도 워크플로여야 한다.

### ⚠️ 이전 판 §6 의 전제 정정

이전 판은 *"전환 중에는 **build 가 정상적으로 빨갛다**"* 고 썼다. **이것은 §S1 의 *"완료 후 즉시 republish"* 와 모순된다** — 각 단계 사이에는 green 이어야 한다. 정확한 서술은:

> **핀 파일을 편집한 순간부터 그 단계의 republish 가 끝날 때까지** build 가 빨갛다. 단계 경계에서는 green 이다.

**결론은 그대로 유효하다**: `05:689` — *"build 를 Tier 0 에 넣으면 전환 기간 내내 CI 가 빨갛고, 그러면 아무도 안 본다."* → **build 무관 Tier 0 만 넣는다.**

### Tier 0 — build 를 타지 않는 것만 (`05:680-687`)

| # | 실행 | 이유 |
|---|---|---|
| 1 | `cd frontend && npm run typecheck` | 기존 스크립트. `payload` 타입 확장 파급을 즉시 잡음 |
| 2 | `cd frontend && npm run lint` | 기존 |
| 3 | `cd server && npx tsc --noEmit` | **build 를 타지 않으므로 P1 게이트 우회** |
| 4 | `cd server && npx tsx src/test-runner.ts` | **build 를 타지 않는다.** `npm --prefix server test` 는 build 를 타므로 **쓰면 안 됨** |
| 5 | `cd server && npx tsx --test src/**/<파일>.test.ts` (파일별, **37개**) | **바이너리 전환의 핵심 스위트.** `test-runner.ts` 가 디스커버리하지 않음. ⚠️ **37개는 `src/ws/` 아래가 아니다** — benchmarks 8 / services 16 / ws 7 / utils 3 / routes 1 / schemas 1 / types 1 (직접 확인, 2차 검증 M-7). `src/ws/` 만 돌면 **30개를 빠뜨린다** |
| 6 | `cd frontend && node --experimental-strip-types --test tests/unit/<파일>` | **Playwright 가 수집하지 않으므로 이것 없이는 영원히 안 돔** |
| **7** | `cd frontend && npx tsc --noEmit -p <tests 포함 tsconfig>` | **신설 권고.** `tsconfig.app.json:27` 이 `"include": ["src"]` 뿐이라 **`frontend/tests/**` 는 어떤 타입 검사도 받지 않는다**(§4.3). 이것 없이는 "필수 필드 → 컴파일 에러" 게이트가 프론트에서 성립하지 않는다 |

### 최소한의 최소 (`05:719-721`)

```bash
cd server   && npx tsx --test src/ws/binaryFrameCodec.test.ts
cd frontend && node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts
```
*"이 두 개가 골든 벡터를 양쪽에서 검증하므로 **두 구현이 갈라지는 사고**(가장 발견이 늦고 가장 비싼 사고)를 막는다."*

### CI 도입 시 손볼 것 (`05:708-715`)

`reuseExistingServer: true` 가 `!process.env.CI` 로 게이팅되어 있지 **않다**(`frontend/playwright.config.ts:36`) · `webServer.command` 가 `cd .. && start.bat --port 2222` 로 **Windows 전용**(`:34`, D8) · **`env -u NODE_ENV npm ci`** (devDependencies 조용한 누락, 메모리 `buildergate_npm_ci_node_env_production_silent_trap`) · `tail` 파이프 금지(exit code 은폐)

⚠️ **정정** (2차 검증 L-19, 직접 확인): 이전 판의 *"`webServer.port` 2222 하드코딩"* 은 **틀렸다.** `playwright.config.ts:35` 는 `port: webServerPort` 이고 `webServerPort` 는 `:4` 에서 `Number(new URL(baseURL).port || 443)` 로 **`PLAYWRIGHT_BASE_URL` 에서 파생**된다. **포트는 환경변수로 override 가능하다.**

→ **실제 하드코딩은 `webServer.command`(`:34`) 쪽**이다: `start.bat --port 2222` 의 `2222` 는 리터럴이므로, `PLAYWRIGHT_BASE_URL` 로 포트만 바꾸면 **Playwright 는 새 포트를 기다리는데 서버는 2222 에 뜨는 불일치**가 생긴다. CI 도입 시 손볼 것은 **`port` 가 아니라 `command` 와 `port` 의 연동**이다.

---

## 13. 체크리스트 — **층 A(착수 전) / 층 B(단계별)** 분리 (§3)

### 층 A — 프로젝트 착수 전 (하드 게이트)

```
[ ] S-1  회귀 기준선 확보 (§5 S-1) — 전환 후 red 귀속을 위해 선행
        └ 8개 그룹 전부. daemon·wave1·server tools·wave3 증거 5개를 빠뜨리지 말 것
        └ server tools 는 2개다 — write-fair-scheduler-evidence-bundle.test.mjs
                                 + ensure-node-pty-windows-hide.test.cjs (3차 검증-B L-3)
        └ server node:test 37개는 src/ws/ 7개가 전부가 아니다 (benchmarks 8 / services 16 / …)
[ ] Q1~Q6 사용자 결정 (§3.4)   ⚠️ D3·D12 보다 **먼저** — 4차 검증 L-6
        └ Q1~Q4 는 04:597-600 정본, Q5·Q6 은 이 계획이 추가한 것 [설계결정]
        └ 특히 Q2(04:598, realtime.terminalWireFormat 키 신설) — 거부 시 stable REQ 2건 폐기
          + 검증 증거 13건 재수집. 그리고 **D12(4값 사다리)는 그 키의 존재를 전제**하므로 무효가 되고,
          **D3(codec × wsTransportMode)는 codec 축을 표현할 자리를 잃어 형태가 바뀐다**
          (거부 분기에서는 wsTransportMode enum 확장으로 되돌아간다 — §4.1 이 배제한 방향)
        └ 즉 Q2 미결 상태에서 D3·D12 를 확정하면 뒤집힐 결정을 AC 로 굳히게 된다
[ ] D1 · D2 · D5 · D10 · D11 결정 (§3 층 A)   — Q2 와 무관하게 진행 가능
        └ D5(롤백 수렴점) · D10(협상 메시지 이름 + 요청/응답 type 공유 모순)
[ ] D3 · D12 결정                              — **Q2 승인 이후**
        └ D12(4값 사다리) · D3(codec × mode 조합 범위)
[ ] §3.1-A  D1 이 기각하는 세 정본의 기각 사유 기록 — S0-b 착수 전 (하드 게이트)
        └ 01:728(전체 길이 재정의) · 02:243(21+payload, 헤더 포함) 기각
        └ 00:78("encoded byte 단일 domain")은 기각하지 않음 — 뜻은 "서버 원장 ↔ 클라이언트 ACK 보고 일치"
          하나로 고정. 와이어 인코딩과의 일치는 00:78 소관이 아니다 (4차 M-1)
        └ C안(05:202) 기각 사유는 00:78 위반이 아니라 "shadow 이후 순 낭비" 하나뿐
        └ AC 문면은 "payload 바이트" 가 아니라 "본문(body) 바이트" — 01:51 의 payloadLength 는 프롤로그 포함
        └ byteLength ≠ encodedBytes 를 같은 AC 에 명문화 (§4.2)
[ ] §3.1-B  JSON codec 의 encodedBytes 도메인 규정 — S0-b 착수 전 (하드 게이트, 4차 H-1)
        └ 이것 없이는 §3.1-A 의 01:728 기각 근거(05:204 인코딩 불변)가 성립하지 않는다
        └ 현행은 봉투 포함이다 (wsSendPolicy.ts:598-611 → :91/:95) — 무수정 항목이 아니라 변경 항목
        └ 결정: 두 codec 모두 본문-only, JSON 측 전환 시점 = S5(S5-a0), floor max(bodyBytes,1)
        └ floor 1 의 사유는 "AC-6 duplicate/over-ACK 판정" 이 아니다 — 그 판정은 오늘 이미
          deliverySeq 에만 의존한다(:836 ACK_DUPLICATE · :837 ACK_OVER_ACK — :838 은
          ACK_OUT_OF_ORDER 라 범위 표기에서 제외, 6차 L-4). 사유는 **예산**: 본문 0 delivery 가 크레딧·큐
          예산을 전혀 쓰지 않고 lane 을 점유하는 구멍을 막는다 (5차 검증 M-1)
        └ AC 문면에 "codec 과 무관하게" 와 floor 를 함께 박는다 (사후 편집 불가)
             ※ 단 codec 무관 조항에 "프레임" 을 쓰지 말 것 — JSON 경로에는 프레임이 없다.
               피연산자는 FairTerminalDeliveryInput.payload(wsSendPolicy.ts:499) 다 (5차 L-5)
        └ 프레임 수 상한은 **두 도메인이 각각** 준다 — floor 1 이 있으면 :701/:758 도 묶는다.
          "byteLength 도메인 소관" 이라는 배타적 문면은 반증 가능하므로 AC 에 박지 않는다 (5차 L-6)
[ ] S0   wave-5 SRS 저작 (§5 S0) — 없이는 코드 작성 불가
        └ Active Target 전환(00.index.md:9) · 신규 REQ 4건 · 노트 6건 · trace 에지 21개
        └ 4값 사다리 · 커밋 순서 조항 삭제(P1 한정) · 두 도메인 분리
[ ] S0.5 provenance republish 리허설 성공 (§5 S0.5) — 4단계 전부
        └ 실패 시: 여기서 중단하고 "착수 불가 + 사유" 보고
[ ] S0.7 FR-BGSTAB-017 상태 확인 (D11)
        └ target = 0.5.5-buildergate-stability / Status=planned / Stability=evolving (확인 완료)
        └ planned 이므로 "미구현 확정" — S4 착수 전 완료 또는 D11 사용자 결정
```

### 층 B — 단계별 게이트

```
[ ] D4 · D7 · D9 (opcode 공간) 결정          → S2 착수 전
[ ] D6 (--expect-red RED 증거 처분)
        → **P3 범위 파일 변경을 커밋하기 전** · **다음 --expect-red 실행 전** 중 먼저 오는 쪽
        ⚠️ 4차 M-2 정정 — 이전 판의 "S3 첫 파일 저장 전" 은 과하게 당긴 것이다.
           git-status 게이트와 프론트 소스 sha256 핀은 --expect-red 전용이다
           (:2470 mode → :2522 → :779 verifyRedProductionUnchanged → :816 이 유일 호출 사슬).
           기본(green) 실행은 워킹트리 dirty 를 보지 않으므로 S3 의 첫 저장이 D6 을 강제하지 않는다.
           기본 실행에서 P3 가 깨지는 진짜 시점은 :938 의 무조건 JSON.parse 때문에 S4 다
[ ] §5 S3 조용한 폐기 경로 8항목 목록화 및 담당 지정
        └ 05:170-176 의 7 + WsRouter.ts:1745 (서버 프로덕션, 05 에 없음)
        └ 이 8항목이 0 이 되는 것이 S4-d(binary-shadow) 진입 조건
[ ] P5 스케줄러 벤치 baseline 재고정          → S4 착수 전 (§1.5)
[ ] §7 항목 9 — TerminalResourcePolicy.test.ts 키 집합 단정 보강  → S5 재측정 전
        └ strategy / visibilityWeight / driverWeight 가 현재 무단정
        └ 기대값은 리터럴로 ('deficit-round-robin' / 8 / 16) — resolver 재호출 금지
[ ] §5 S3 subprotocol 협상 3지점 배정 확인       → S3 착수 전 (3차 검증-B L-8)
        └ WsRouter.ts:612(handleProtocols) — P1 핀 파일이므로 저장 후 republish 필수
        └ WebSocketContext.tsx:1201 · :1007 — 생성자 인자 추가
[ ] S5-a0 encodedBytes 도메인 전환 (JSON codec 측)  → S5-a 재측정 *전* (4차 H-1)
        └ wsSendPolicy.ts:598-611 → Math.max(1, Buffer.byteLength(input.payload,'utf8'))
        └ FairTerminalDeliveryScheduler.test.ts 의 S1 봉투 기대값을 본문 리터럴
          (12 / 9, expectedBytes 21)로 교체 — 이 교체가 도메인 전환의 가시적 증거다
             ※ S1 이 남긴 것은 맨 숫자 131/128 이 아니라 **손으로 적은 봉투 문자열 +
               Buffer.byteLength(...)** 이다 (§7 항목 1 주). 테스트에서 131 을 grep 해도
               나오지 않는다 — 교체 대상은 그 표현식 전체다 (5차 검증 L-2)
        └ 경계 대조군: 본문 0바이트 delivery 의 encodedBytes === 1
             ※ red 방향 두 값은 0(floor 미적용) 과 **119**(전환 전 봉투값). **52 가 아니다** —
               S5-a0 시점 산출식은 fairDeliveryBytes()(JSON) 하나뿐이라 52 가 될 경로가 없다 (6차 L-2)
        └ 두 번째 ACK(seq3)를 추가해 creditedBytes(델타, :839-840)와 creditBytes(누적, :843)를
          갈라 놓을 것 — 현행 단정은 lastAcknowledgedSeq=0 이라 두 값이 우연히 같다 (5차 M-3)
        └ 관측 동작 변화 ②: 본문이 smallOutputBypassBytes 임계 아래로 내려간다 — ⚠️ **범위 축소**
          (6차 검증 H-1). soft gate(:702-703)는 저한도 구성·스키마 기본값 **둘 다에서 사문**이다
          (:701 이 socketQueuedBytes < creditWindowBytes 를 보장하는데 softGate ≥ creditWindow),
          deficit 대조(:716-717)는 :800 의 선적립 quantum(2048/4096) 때문에 판별력이 없다.
          저한도 구성에서 실제로 갈리는 것은 **:738-739 차감 하나뿐**이다
        └ ② 전용 실패 테스트는 **저한도 구성이 아니라 주입 하네스**로 세운다 (6차 H-1)
             ※ createPolicy({ socketSoftGateBytes: { value: 64, source: policySource },
                              smallOutputBypassBytes: { value: 128, source: policySource } })
               (FairTerminalDeliveryScheduler.test.ts:132 / :147 — resolver 를 거치지 않는다)
               ⚠️ 필드 타입이 {value, source} 다 (:101-111 / :133-143). 맨 숫자는 컴파일 안 됨 (7차 L-1)
               ⚠️ quantum 은 384 가 아니라 **256** — enqueue 가 serviceClass 를 안 넘겨 driverWeight 2
                 가 쓰인다 (:706-712, 하네스 :138-139). 결론(≥129)은 유지 (7차 L-3)
               ⚠️ 처치군에서 :703 bypass 가지가 처음 필요한 것은 2번째가 아니라 **3번째** delivery —
                 누적은 전송 후(:727)라 2번째 판정 시점의 socketQueuedBytes 는 40 이다 (7차 L-2)
             ※ 129B 경계 대조군의 기전은 :717 이 아니라 **:703**(또는 :738-739) 이다 (6차 M-2)
             ※ deficitBytes 는 snapshot() 이 노출하지 않는다(:882-899) — 사설 필드 캐스트 금지.
               ⚠️ 대체 관측을 **라운드 수로 하면 vacuous** 하다 (7차 M-1) — :812-814 가 같은 drain()
                 안에서 quantum 을 재적립하며 재시도하고, 라운드 카운터·sentCount·now 어느 것도
                 갈리지 않는다. **경쟁 lane 을 하나 더 두고 sent 의 순서(round-robin 스킵)를 단정할 것**
                 (quantum 8 / lane A 본문 65 → A1 앞에 lane B 8건 / 대조군 본문 64 → A1 이 인덱스 0)
        └ 전환 전 숫자로 아티팩트를 재발행하면 낡은 도메인이 고정된다 — 순서를 지킬 것
[ ] S5-a 정책 키 9개 처분 확정 = 5 + 3 + 1      → S5 착수 전 (5차 검증 M-2)
        └ [재측정] 값이 움직이는 바이트 5개: socketSoftGate · bulkSlice · smallOutputBypass
                                            · creditWindow · queueMax
             ※ 전부 delivery.encodedBytes 와 비교된다(:701 / :702-703 / :716-717 / :738 / :758)
               → 값을 움직이는 것은 S5-a0 도메인 전환이고 바이너리 인코딩 전환은 0× 다 (5차 H-1)
             ※ bulkSlice 만 두 도메인에 걸쳐 있다 — deficit quantum(:706-712, 대조 :717)은
               encodedBytes 도메인, 배치 상한(01:1401, out.length)은 와이어 도메인.
               **두 역할을 각각 재측정**한다 (a: S5-a0 직후 JSON 상태 / b: binary-optin 이후)
        └ [재귀속만] 비율 2개(visibilityWeight=8 · driverWeight=16) + strategy 문자열
             ※ 무조건 항등식이 아니다 — controlLimit ≥ 64 / outputLimit ≥ 16 에서만 성립.
               config.schema.ts:124-125 의 하한 1024 가 그 조건을 보증한다 (3차 검증-B M-4)
        └ [별도] ackTimeoutMs — 시간 도메인(:824 는 바이트를 보지 않는다). 재측정 범위에는
          넣되 바이트 5개와 같은 처분을 적용하지 않는다. 영향 [추정] (5차 M-2)
        └ 재벤치 한도 구성을 먼저 고정할 것 — 기본값(control 262144 → bypass 32768)에서는
          smallOutputBypass 의 전환 영향이 0 으로 관측된다 [추정] (§5 S5-a #4 주)
[ ] D8 (Playwright CI 러너 OS)                → §12 CI 도입 시
[ ] §12 Tier 0 CI 워크플로 도입 (build 를 타지 않는 7개 — frontend tests tsconfig 포함)
```

---

## 14. 검증 반영 기록 — 반영·기각

### 14.0-A 독립 검증 **7차** — 전건 반영, **기각 0건 · 범위 정정 1건**

> ⚠️ **번호 체계 주의.** §14 의 하위 절은 **최신이 앞**(14.0 = 6차 · 14.1 = 5차 · …)이라 7차를 `14.0` 으로 넣으면 기존 하위 절이 전부 밀려 문서 곳곳의 `§14.0`·`§14.1 L-6`·`§14.2` 상호참조가 깨진다. **그래서 7차만 `14.0-A` 로 앞에 붙였다** — 기존 번호는 하나도 바꾸지 않았다. 다음 라운드도 같은 방식(`14.0-B`)을 쓰거나, 전면 재번호를 하려면 상호참조를 함께 고칠 것.
>
> ⚠️ **라벨 주의 — 이 절의 항목은 `7차 검증 X-N`** 이고 본문 인용부도 같은 표기를 쓴다. 선행 패스는 `6차 검증 X-N`(§14.0) · `5차 검증 X-N`(§14.1) · `4차 검증 X-N`(§14.2) · `3차 검증-B X-N`(§14.3) · `3차 검증 X-N`(접미사 없음, §14.3 주) 이다. **접두 패스명 없이 `H-1` 이라 쓰지 않는다** — `H-1` 은 이제 여섯 패스에 존재한다.

인용된 `file:line` 을 **전부 직접 열어** 재확인했다. **6건(HIGH 1 · MEDIUM 1 · LOW 4) 중 기각할 것이 없었다.** 이번 라운드의 HIGH 는 6차 H-3 과 **같은 계열의 한 단계 더 깊은 결함**이다 — 6차는 *"두 설정 키의 상대 크기가 무제약"* 을 지적했고, 7차는 그중 한 키를 **평가하는 코드 경로 자체가 `wsSendMode` 에 종속**임을 지적한다.

| finding | 재확인한 사실 (직접 확인) | 반영 위치 |
|---|---|---|
| **H-1** §3.1-B 지시 3 의 "두 도메인이 각각 상한을 준다" 가 **특정 키를 이름으로 박은 형태에서는 거짓** — ②로 지목한 게이트가 `wsSendMode` 종속 | ✅ **전건 사실.** ① `server/src/schemas/config.schema.ts:201` `wsSendMode: z.enum(['direct','safe-send-observe','safe-send-enforce']).default('direct')` ② `WsRouter.ts:6082` `const mode = this.runtimeSendPolicyConfig.mode;` → **`:6086-6094`** `if (mode === 'direct') { … return … }` — `:6097` `const limits = …` **이전에 early return** 하므로 `:6098-6099` `bufferedAmount + message.byteLength >= limits.serverBufferedHardLimitBytes` 는 **기본 배포에서 한 번도 평가되지 않는다** ③ `:6100-6103` `safe-send-observe` 는 `transportBackpressureObserveCount += 1` 후 `sendRawTransportMessage(ws, message)` 로 **그대로 전송**(상한 미폐쇄) — 실제로 닫는 것은 `:6105` `closeBackpressuredClient(ws, 'server-buffered-hard-limit')` 로 가는 `safe-send-enforce` 뿐 ④ **구제 경로도 사실** — direct 는 `:6089` `enqueueTransportMessage(ws, directState, message)` 를 호출하고, 그 4번째 인자 기본값이 `:6158` `outputQueueMaxBytes = this.getEffectiveOutputQueueLimit(ws, message)`, `:5761-5763` 이 canary 미적용 시 `this.runtimeSendPolicyConfig.limits.perClientOutputQueueMaxBytes` 를 돌려주며, 강제는 `:6169` `nextOutputBytes > outputQueueMaxBytes` 다 ⑤ 반증 구성 산수도 **재검산 통과** — `bytesLimit(1024, 268435456, 2097152)`(`:124`) 하한 1024 합법 / `bytesLimit(1024, 536870912, 33554432)`(`:123`) 상한 합법 / `:127-135` `superRefine` 은 hard > high 만 본다. **부수 발견 2건**(finding 이 지목하지 않은 것): ⓐ direct 모드의 `byteLength` 상한은 **①과 같은 설정 키**(`perClientOutputQueueMaxBytes`)에서 오므로 *"두 상한은 서로 다른 설정 키에서 온다"* 는 서술도 모드 종속이다 ⓑ 강제 지점이 `:6169` 하나가 아니라 **`:6182` `state.outputBytes + message.byteLength > outputQueueMaxBytes`** 도 있고, 애초에 그 경로는 `:6088` `directState.sending \|\| hasTransportQueuedMessages(directState)` 일 때만 타므로 **큐가 한가하면 `:6093` `sendRawTransportMessage` 가 상한 검사 없이 나간다** → direct 모드에서 ②가 묶는 것은 **적재량**이지 총 프레임 수가 아니다 | **§3.1-B 0B 처분 표 3행**(`wsSendMode` 종속 · 세 모드별 거동 · direct 구제 경로 · 부수 발견 ⓐⓑ · line 427 의 "기본 배포에서는 ②가 실효 상한 ≈645,277 프레임" 폐기) · **§3.1-B S0 지시 3**(AC 문면을 **도메인 수준**으로 교체, 설정 키 이름 금지) · **S0 지시 5**(`wsSendMode` 종속을 노트 필수 항목으로 등재) · **§5 S5-a 말미**(재벤치 구성에 `wsSendMode` 고정·기록 요구) · **§10.1**(게이트 모드 종속 · 28/52 산수는 세 모드 모두 유지) · 부록 2행 |
| **M-1** 129 B 대조군의 대체 관측(round-delay)이 단일 lane 에서 vacuous | ✅ **전건 사실.** ① 이동 자체 확인 — `:717` `lane.deficitBytes >= delivery.encodedBytes`(canSpendDeficit) / `:703` bypass 가지 / `:738-739` 차감 ② `deficitBytes` 비노출 확인 — `snapshot()` `:882-899` 의 lane 필드는 `queuedBytes`·`socketQueuedBytes`·`creditBytes`·`sentDeliverySeqs` 뿐이고, `deficitBytes` 는 `:565`·`:652`·`:717`·`:739`·`:800` 에만 등장 ③ **처방이 관측 불가라는 지적이 정확하다** — `:812-814` `if (!selected) { if (waitingForDeficit) continue; break; }` 가 **같은 `drain()` 호출 안에서** `:800` 적립을 반복하며 재시도하므로 65 B 도 결국 같은 호출 안에서 전송된다. 라운드 카운터 미노출 · `sentCount` 는 `:791`/`:817` 에서만 증가(대기 라운드에 증가하지 않아 `:775` `maxDeliveries` 로도 안 드러남) · `options.now()` 는 drain 중 전진하지 않아 `:730` latency 도 동일 → **처치군·대조군 동일 결과 = 판별력 0** ④ **제시된 대안(경쟁 lane + `sent` 순서)은 성립한다** — `:794-811` 이 deficit 대기 lane 을 `:803` `continue` 로 스킵하고 다음 lane 을 선택하며 `:808` 로 커서를 되돌리므로, quantum 8 / lane A 본문 65 / lane B 본문 40(≤ bypass 64) 구성에서 **A1 앞에 B 8건**(⌈65/8⌉ = 9번째 라운드)이 온다. 대조군(A 본문 64)은 `:716` 이 참이라 A1 이 **인덱스 0** — 1 바이트 차이로 갈린다. 사전 control 우선 패스(`:780-789`)는 output-only 워크로드에서 아무것도 선택하지 않아 교란하지 않는다 | **§5 S5-a0 "실패 테스트 (② 전용)" 의 `:738-739` 축 항목 전면 재작성**(vacuity 사유 + 경쟁 lane 처방 + 경계 대조군 + 교란 배제 조건) · §13 층 B 체크리스트 |
| **L-1** `createPolicy({ socketSoftGateBytes: 64, … })` 가 컴파일되지 않음 | ✅ 사실. `FairTerminalDeliveryScheduler.test.ts:101-111` `interface SchedulerPolicy` 의 9개 필드가 전부 `{ value: number; source: string }`(`strategy` 만 `string`), `:133-143` `createPolicy()` 기본값도 같은 형태, 기존 호출부도 `:269`·`:380-386` 처럼 `{ value, source }` 로 넘긴다 | **§5 S5-a0 처방** · §13 층 B |
| **L-2** *"두 번째부터 `socketQueuedBytes`(80) ≥ softGate(64)"* 가 한 칸 어긋남 | ✅ 사실. 누적은 전송 **후**(`:727` `lane.socketQueuedBytes += delivery.encodedBytes`)이므로 판정 시점 값은 1번째 **0** / 2번째 **40** / 3번째 **80** 이다. `:702`(`< 64`)는 2번째까지 참이고 `:703` bypass 가지가 처음 필요한 것은 **3번째**. 전환 전(≈159 B)은 1번째 전송 후 159 ≥ 64 이고 `159 ≤ 128` 이 거짓이라 **2번째부터 정체** — red→green 성립은 그대로다 | **§5 S5-a0 처치군 항목** · §13 층 B |
| **L-3** quantum **384** 는 `serviceClass:'visible'` 전제 | ✅ 사실. `deficitQuantum()` `wsSendPolicy.ts:706-712` 는 `delivery.serviceClass === 'visible'` 일 때만 `visibilityWeight` 를 쓰고 그 외에는 `driverWeight` 를 쓴다. 하네스 기본값은 `:138-139` `visibilityWeight` **3** / `driverWeight` **2** 이고, 테스트의 `enqueue({...})` 호출 관례가 `serviceClass` 를 넘기지 않으므로 **quantum = 128 × 2 = 256**. **결론(quantum ≥ 129 → deficit 미개입)은 256 에서도 유지**되므로 설계는 무해하고 수치만 정정 | **§5 S5-a0 처방** · §13 층 B |
| **L-4** 9키 표 #3 행이 deficit 적립을 `:801` 로 인용 | ✅ 사실. **`:800`** `candidate.deficitBytes += deficitQuantum(delivery);` / **`:801`** `if (!canSpendDeficit(candidate, delivery)) {`. 같은 문서 line 1388(관측 동작 변화 ②)·§14.0 M-2 행은 `:800` 으로 정확했다 — **한 곳만 어긋나 있었다** | **§5 S5-a 9키 표 #3 행** |

> **기각 0건.** 다만 H-1 은 finding 이 제시한 구제 경로를 **그대로 채택하지 않고 범위를 좁혀 반영**했다 — 부수 발견 ⓑ(직접 확인) 때문에 *"direct 모드에도 byteLength 도메인 상한이 있다"* 는 **적재량 상한**으로만 참이고 총 프레임 수 상한으로는 참이 아니다. **참인 무조건 명제는 도메인 수준의 "각각 준다" 하나뿐**이라는 결론(6차 H-3)은 유지되며, 7차는 거기에 **"설정 키를 이름으로 박지 말 것"** 을 더한다.
>
> **7차가 "확인되어 건드리지 말 것" 으로 지목한 항목은 손대지 않았다** — ②-전용 테스트의 하네스 선택(resolver 미경유, 기본 softGate 512 < creditWindow 2048), 봉투 **159 B**(= 119 + 40) 산수와 red→green 성립, 9키 표 #2 단서(soft-gate 사문: 12,288 ≥ 4,096 / 8,388,608 ≥ 2,097,152), §10.1 의 28-vs-52 재귀속과 `01:1401`/`:1411`/`:1429` 인용, §5 S5-a 말미 6차 M-1 정정과 §14.1 L-6 등재, `:717` vacuous 판정과 `deficitBytes` 비노출, §1.5 P1 `:8` 추가와 제외 3건 사유, L-2 의 "정확히 119 B", L-3 의 AC 중립화(`FairTerminalDeliveryKind` 5종 · `:757` 무조건 계상). **이 목록은 다음 라운드의 재조사 제외 대상이다.**
>
> ⚠️ **`config.schema.ts` 의 실제 경로는 `server/src/schemas/config.schema.ts`** 다(직접 확인). 이 문서는 6차까지 파일명만으로 인용해 왔고 이번 판도 그 표기를 유지했다 — **줄번호는 전부 그 파일 기준이며 `server/src/config.schema.ts` 는 존재하지 않는다.**

### 14.0 독립 검증 **6차** — 전건 반영, **기각 0건 · 수치 정밀화 1건**

인용된 `file:line` 을 **전부 직접 열어** 재확인했다. **9건(HIGH 3 · MEDIUM 2 · LOW 4) 중 기각할 것이 없었다.** 이번 라운드의 세 HIGH 는 전부 **"코드가 그 구성에서 그 경로에 도달하지 못한다"** 는 같은 종류의 결함이다 — 산수는 맞았으나 **피연산자·도달 가능성·전제 구성**이 틀렸다.

> ⚠️ **라벨 주의 — 이 절의 항목은 `6차 검증 X-N`** 이고 본문 인용부도 같은 표기를 쓴다. 선행 패스는 `5차 검증 X-N`(§14.1) · `4차 검증 X-N`(§14.2) · `3차 검증-B X-N`(§14.3) · `3차 검증 X-N`(접미사 없음, §14.3 주) 이다. **접두 패스명 없이 `H-1` 이라 쓰지 않는다** — `H-1` 은 이제 다섯 패스에 존재한다.

| finding | 재확인한 사실 (직접 확인) | 반영 위치 |
|---|---|---|
| **H-1** S5-a0 "실패 테스트 (② 전용)" 이 지정 구성에서 충족 불가능 | ✅ **전건 사실.** ① `TerminalResourcePolicy.test.ts:1553-1558` 호출값 = `serverBufferedHighWaterBytes: 12_288` / `perClientOutputQueueMaxBytes: 4_096` / `perClientControlQueueMaxBytes: 1_024` / `outputCoalesceWindowMs: 16`, 단정값은 `:1559-1577`(softGate **12,288** · bulkSlice **256** · bypass **128** · creditWindow **4,096** · queueMax **4,096** · ackTimeout **5,000**) ② `TerminalResourcePolicy.ts:37-38` `socketSoftGateBytes = serverBufferedHighWaterBytes` / `:57-58` `creditWindowBytes = outputLimit = perClientOutputQueueMaxBytes` ③ `wsSendPolicy.ts:699-704` `eligible()` 에서 **`:701` 이 `:702-703` 보다 먼저** 판정하고 통과 조건이 `socketQueuedBytes + encodedBytes ≤ creditWindowBytes` 이므로, `:702-703` 도달 시 **항상 `socketQueuedBytes < creditWindowBytes`** → `socketSoftGateBytes ≥ creditWindowBytes` 인 구성에서 `:702` 는 항상 참이고 `:703` 의 bypass 가지는 **죽는다** ④ **스키마 기본값도 같다** — `config.schema.ts:122` `serverBufferedHighWaterBytes` 기본 **8,388,608** ≥ `:124` `perClientOutputQueueMaxBytes` 기본 **2,097,152**. `:127-135` `superRefine` 은 hard/high 관계만 본다 ⑤ **주입 하네스는 다르다** — `FairTerminalDeliveryScheduler.test.ts:135-142` `createPolicy()` 기본값이 softGate **512** < creditWindow **2048**, bypass **32** 라 soft gate 가 실제로 발동한다. **부수 발견** — `:716-717` 도 저한도 구성에서는 판별력이 없다(M-2 참조). 즉 그 구성에서 실재하는 변화는 **`:738-739` 하나뿐**이며, `deficitBytes` 는 `snapshot()`(`:882-899`)이 노출하지 않아 공개 API 로 직접 관측할 수 없다 | **§5 S5-a0 "관측 동작 변화 ②" 행 범위 축소 + "실패 테스트 (② 전용)" 행 전면 재작성**(주입 하네스 처방 · 처치군/대조군 산수 · `:738-739` 축 별도 처방) · §13 층 B · §0 개정 요약 35행 |
| **H-2** §10.1 에 와이어 도메인 추론 잔존 | ✅ **전건 사실.** `wsSendPolicy.ts:702-703` · `:716` 의 피연산자는 **`delivery.encodedBytes`** 이고, S5-a0 이후 그것은 `Math.max(1, Buffer.byteLength(input.payload,'utf8'))` = 본문 바이트다 → **프레임 고정비 28/52 는 bypass 판정에 들어가지 않는다.** 같은 문서 §5 S5-a #4 주가 5차 H-1 에서 *"92 도 356 도 `smallOutputBypassBytes` 의 피연산자가 아니다"* 로 폐기한 추론이 §10.1 에만 남아 있었다. **부수 확인** — 28/52 가 실제로 걸리는 곳은 `WsRouter.ts:6098-6099`(백프레셔)·`01:1401`/`01:1411`(배치 상한 `out.length`)·§10.3 절감률 셋이며 이들은 전부 `byteLength` 도메인이다 | **§10.1 정정 표 아래 본문** — bypass 무관 명시 + 28/52 의 실제 소관 열거 |
| **H-3** AC 문면 지시 3 이 반증 가능한 명제를 굳힘 | ✅ **전건 사실.** *"실효 상한은 프레임당 바이트가 큰 `byteLength` 쪽이 준다"* 의 근거(§3.1-B 표 3행)는 *"프레임당 52 B 대 1 B 이므로 ②가 ①보다 52배 먼저 걸린다"* 인데, 이것은 **두 예산 크기가 같다고 가정**한 산수다. 실제 피연산자는 서로 다른 키다 — ① `:701` 상한 = `creditWindowBytes` = `perClientOutputQueueMaxBytes`, `bytesLimit(1024, 268435456, 2097152)`(`config.schema.ts:124`) / ② `WsRouter.ts:6098-6099` 상한 = `serverBufferedHardLimitBytes`, `bytesLimit(1024, 536870912, 33554432)`(`:123`). **기본값 검산**: ② 33,554,432 / 52 ≈ **645,277** < ① **2,097,152** → 성립. **반증 구성 검산**: `perClientOutputQueueMaxBytes=1024`, `serverBufferedHardLimitBytes=536,870,912` (`:127-135` `superRefine` 은 `serverBufferedHardLimitBytes > serverBufferedHighWaterBytes` 만 강제하므로 **두 키 관계는 무제약**) → ① **1,024** < ② ≈ **10,324,440** → **반증.** §14.1 L-6 이 *"배타적 소관으로 쓰면 반증 가능한 계약이 된다"* 고 경계한 것과 **같은 종류의 오류가 정정 문면에 남았다** | **§3.1-B S0 지시 3 전면 재작성**(참인 무조건 명제로 교체 + 조건절 안의 노후화 위험 명시) · **§3.1-B 0B 처분 표 3행**(두 키·범위·기본값·반증 구성) · §0 개정 요약 22행 주 · §13 층 A 는 이미 정확했으므로 무수정 |
| **M-1** §5 S5-a 말미가 5차 L-6 정정 이전 문면 유지 | ✅ 사실. §3.1-B 표 1행(`06` 본문)·S0 지시 3 은 5차에서 *"두 도메인이 각각 상한을 준다"* 로 고쳐졌는데 **§5 S5-a 말미 한 줄만 배타적 소관으로 남았고**, §14.1 L-6 행의 반영 위치 목록에도 §5 S5-a 가 없었다 | **§5 S5-a 말미 문단** · **§14.1 L-6 행 반영 위치**에 §5 S5-a 등재 |
| **M-2** 129 B 경계 대조군의 기전(`:717`)이 129 B 에서 발동 안 함 | ✅ 사실. `wsSendPolicy.ts:799-801` 이 `canSpendDeficit()` **전에** `candidate.deficitBytes += deficitQuantum(delivery)` 를 실행하고(`:800`), quantum = `bulkSliceBytes(256) × weight`(`:706-712`) 이며 weight 는 `TerminalResourcePolicy.ts:50` visible **8** / `:54` driver **16** → **2,048 또는 4,096**. `129 ≤ 2,048` 이므로 `:717` `lane.deficitBytes >= delivery.encodedBytes` 는 **항상 참** → 전환 전후 어느 쪽도 red 가 안 되는 vacuous 대조군. **부수 확인** — 전환 **전** 값(≈356)에 대해서도 `:717` 은 참이므로 `:716-717` 축 자체가 그 구성에서 판별력이 없다. 128/129 에서 실제로 갈리는 것은 **`:738-739`**(deficit 차감)과, softGate < creditWindow 인 정책에서의 **`:703`** 둘뿐 | **§5 S5-a0 "실패 테스트 (② 전용)" 경계 대조군 항목** · §13 층 B |
| **L-1** §1.5 P1 "06 이 건드리는 것" 열거 누락 | ✅ 사실. `server/tools/write-fair-scheduler-source-provenance.mjs:7-14` = `const sourcePaths = [` + 6개 경로(`:8` `src/benchmarks/terminalFairnessCharacterization.ts` · `:9` `fairSchedulerAuthorityLocator.ts` · `:10` `src/ws/wsSendPolicy.ts` · `:11` `src/ws/WsRouter.ts` · `:12` `src/services/TerminalResourcePolicy.ts` · `:13` `TerminalResourcePolicyCanary.ts`) + `];`. §7 항목 5 가 `terminalFairnessCharacterization.ts:1093` 수정을 **S5** 에 배정하며 *"P1 재발행 유발"*(`02:529`) 이라 적는다. **단계 배정 영향 없음**(매트릭스 S5 는 이미 P1 ●)이라는 finding 의 단서도 정확 | **§1.5 P1 상세표** (나머지 3개는 편집 대상 미지목이라 제외 사유를 함께 기록) |
| **L-2** S5-a0 경계 대조군의 "52" | ✅ 사실. S5-a0 시점의 `encodedBytes` 산출식은 `fairDeliveryBytes()`(JSON 봉투) 하나뿐이라 **52 가 될 경로가 없다** — 52 는 바이너리 최소 유효 OUTPUT 프레임(§4 S2-b F1)의 값이다. ⚠️ **수치 정밀화**: finding 의 *"본문 0 delivery 의 봉투는 ≈119 B"* 는 **정확히 119 B** 다(직접 계산). 봉투 `{"type":"output","sessionId":"session-a","data":"","connectionEpoch":"epoch-a","deliverySeq":1,"deliveryKind":"output"}` = **119자 전건 ASCII** = 119 B 이고, §7 항목 1 주의 **131 = 119 + 12**(`'한글-alpha'`) · **128 = 119 + 9**(`'🙂-beta'`) 와 정합한다. **`deliverySeq` 가 두 자리 이상이면 그만큼 커지므로 맨 숫자로 박지 않는다** | **§5 S5-a0 경계 대조군 행** · §13 층 B |
| **L-3** AC 문면 예시가 ledger 실제 범위보다 좁음 | ✅ 사실. `wsSendPolicy.ts:493` `export type FairTerminalDeliveryKind = 'output' \| 'dataGap' \| 'checkpoint' \| 'readyBarrier' \| 'control';` — **5종**이고, `fairDeliveryBytes()` 호출부 `:757` `const encodedBytes = fairDeliveryBytes(input, deliverySeq);` 는 `enqueue()` 안에서 **`kind` 분기 없이** 전건에 적용된다. AC 에 *"터미널 출력 바이트"* 를 박으면 나머지 4종의 회계가 문면상 미규정으로 남고 **AC 는 사후 편집 불가**(`04:18-31`, `04:141`) | **§3.1-B S0 지시 2 의 AC 문면 예시** — *"delivery 입력 payload"* 로 중립화 + 함정 주 추가 |
| **L-4** `:836-838` 범위 표기 | ✅ 사실. `:836` `ACK_DUPLICATE` / `:837` `ACK_OVER_ACK` / **`:838` `ACK_OUT_OF_ORDER`**. 세 줄 모두 `deliverySeq` 만 보므로 **주장은 참**이나, §3.1-B 표 3행이 `:836`·`:837` 로 정확히 적은 것과 표기가 달랐다 | **§5 S5-a0 변경 지점 행** |

> **6차가 "재확인되어 건드리면 안 된다" 고 지목한 항목은 손대지 않았다** — 이번 판 신규·수정 인용 전수 대조 오류 0건, 40B 추적표(≈356 → 40 → 40), `40/128 = 31.25%`, `5+3+1=9` 의 네 곳 일치, §7 봉투 리터럴 131/128 및 총 127자/ASCII 125자·총 125자/ASCII 124자·본문 12/9/21, floor 1 의 예산 효과, 4차·5차 부분 기각 2건(기본 bypass = `floor(262144/8)` = 32,768 포함), **핀 3표(매트릭스·상세표·단계별 행) 완전 일치**, `creditedBytes` 델타/누적 분리 서술 전건, 도메인 귀속의 §3.1-B·§4.2·§5 9키표·§13·부록 일관성(§7·§13 은 이번에도 깨끗). **이 목록은 다음 라운드의 재조사 제외 대상이다.**
>
> ⚠️ **다만 §1.5 P1 의 "건드리는 단계" 행은 이번에도 손대지 않았다** — L-1 이 고친 것은 **파일 열거**이고 단계 배정은 매트릭스와 이미 일치한다. **핀 3표 규칙(§1.5 매트릭스 주의)은 여전히 유효하며, 파일 열거는 그 세 표에 속하지 않는 네 번째 축**이다.

### 14.1 독립 검증 **5차** — 본론 전건 반영, **수치 2건 부분 기각**

인용된 `file:line` 을 **전부 직접 열어** 재확인했다. **10건(HIGH 1 · MEDIUM 3 · LOW 6) 의 지적 방향은 전부 사실이었고, 그중 H-1 의 수치 2건만 근거와 함께 정정해 반영했다.**

> ⚠️ **라벨 주의 — 이 절의 항목은 `5차 검증 X-N`** 이고 본문 인용부도 같은 표기를 쓴다. 선행 패스는 `4차 검증 X-N`(§14.2) · `3차 검증-B X-N`(§14.3) · `3차 검증 X-N`(접미사 없음, §14.3 주), **후행 패스는 `6차 검증 X-N`(§14.0)** 이다. 항목 번호가 패스마다 겹치므로 **접두 패스명 없이 `M-1` 이라 쓰지 않는다.**

| finding | 재확인한 사실 (직접 확인) | 반영 위치 |
|---|---|---|
| **H-1** §5 S5-a 9키 표와 #4 주가 와이어 바이트 도메인으로 추론 | ✅ **전건 사실.** `server/src/ws/wsSendPolicy.ts` 를 직접 열어 확인 — `:701` `lane.socketQueuedBytes + delivery.encodedBytes > options.policy.creditWindowBytes.value` / `:702-703` `lane.socketQueuedBytes < …socketSoftGateBytes.value \|\| delivery.encodedBytes <= …smallOutputBypassBytes.value` / `:716-717` `delivery.encodedBytes <= …smallOutputBypassBytes.value \|\| lane.deficitBytes >= delivery.encodedBytes` / `:738` `delivery.encodedBytes > …smallOutputBypassBytes.value` / `:758` `lane.queuedBytes + encodedBytes > …queueMaxBytes.value`. 누적도 같은 도메인 — `:727` `lane.socketQueuedBytes += delivery.encodedBytes` · `:769` `lane.queuedBytes += encodedBytes`. **`bulkSliceBytes` 두 역할 분리 지적도 사실** — deficit quantum `:706-712`(`bulkSliceBytes.value × weight`) 적립 `:801`, 대조 상대가 `:717` 의 `delivery.encodedBytes` → encodedBytes 도메인 / 배치 상한은 `01:1401` `const limit = policy.bulkSliceBytes.value` + `01:1411` `while out.length < limit` → 와이어 도메인. **4차에서 재귀속된 것이 `creditWindowBytes` 하나뿐이었다는 것도 사실** | **§5 S5-a 9키 표 전면 개정**(열 이름 · #1~#9 재귀속 · #3 두 역할 분리) + 그 앞에 코드 근거 표 신설 · §5 S5-a 말미 귀속표에 일치 규칙 · §5 S5-a0 · §5 S0-c · §13 층 B · 부록 |
| **H-1 부속 ⓐ** *"두 codec 모두 본문 42, 42/128 ≈ 33%"* | ⚠️ **방향은 사실, 수치는 부분 기각.** #4 주의 예시는 **40 B 청크**(`02:272`·`02:366`)이고 전환 후 `encodedBytes` = `Buffer.byteLength(input.payload,'utf8')` = **40** 이다. **42 는 §10.2 의 다른 예시**(42바이트 원본 → JSON 프레임 142, 3.38×)에서 온 값으로 두 예시가 섞였다. 따라서 여유 폭도 42/128 ≈ 33% 가 아니라 **40/128 = 31.25%** 다. **finding 의 나머지 넷(피연산자·원인·시점·0×)은 전부 채택** | **§5 S5-a #4 주** — 시점별 추적표(≈356 → 40 → 40) |
| **H-1 부속 ⓑ** *"본문 42B 가 `smallOutputBypassBytes` 를 상시 통과해 soft gate·deficit 회계를 우회하게 된다"* | ⚠️ **사실이나 무조건이 아니다 — 조건을 붙여 반영.** 스키마 기본값(control 262144 → bypass **32768**)에서는 **봉투 도메인 값(≈356)도 이미 임계 아래**라 전환 전후로 바뀌는 것이 없다. 이 변화가 관측되는 것은 **튜닝된 저한도 구성(bypass 128)** 뿐이며, 그것은 #4 주의 뒤집힘과 **같은 조건**이다. finding 이 무조건으로 서술한 부분만 정정하고 등재 요구는 채택 | **§5 S5-a0 "관측 동작 변화 ②" 행 신설 + 전용 실패 테스트 행**(129 B 경계 대조군 포함) · §13 층 B |
| **M-1** floor 사유가 코드로 반증됨 | ✅ **전건 사실.** `wsSendPolicy.ts:836` `if (input.deliverySeq <= lane.lastAcknowledgedSeq) return recordError('ACK_DUPLICATE', …)` / `:837` `if (input.deliverySeq > lane.nextDeliverySeq - 1) return recordError('ACK_OVER_ACK', …)` — **바이트를 보지 않는다.** AC-6(`docs/spec/30.buildergate-stability.srs.md:3678`, 직접 인용) = *"Duplicate, stale, unknown, out-of-order와 over-ACK는 credit을 증가시키지 않고 observable protocol error로 남아야 하며 client가 보낸 byte count를 신뢰해서는 안 된다."* **부수 확인** — `:830` 시그니처의 `clientBytes?: number` 는 받기만 하고 함수 본문 어디서도 읽지 않는다(AC-6 후단과 정합). **"예산 효과가 있다" 는 지적도 사실**: floor 1 이면 `:701`·`:758` 이 delivery 수를 각각 `creditWindowBytes`·`queueMaxBytes` 개로 묶는다 | **§3.1-B 0B 처분 표 3행 전면 재작성**(사유를 예산으로) · 같은 표 1·2행(L-6) · §13 층 A |
| **M-2** `ackTimeoutMs` 처분이 세 곳에서 다름 | ✅ 사실. §5 S0-c = *"…`ackTimeoutMs` 는 재발행된 아티팩트에 재귀속한다"* / §5 S5-a #8 = *"재측정 범위에는 넣는다 `[추정]`"* / §13 층 B = 5·3 어느 쪽도 아닌 세 번째 줄. **부수 확인** — `:824` `now - (lane.lastServiceAt ?? now) >= options.policy.ackTimeoutMs.value` 로 **바이트를 보지 않는 시간 도메인 키**이며, 4차 M-3 이 "비율/문자열 4개" 에 밀어 넣은 것이 오류다 | **§5 S0-c 행 재작성**(`5 + 3 + 1` 저작 문면) · §5 S5-a 결론 · §13 층 B |
| **M-3** `creditedBytes(ACK)` 를 누적 총액으로 정의 | ✅ 사실. `:839` `const acknowledged = lane.sent.filter(delivery => delivery.deliverySeq > lane.lastAcknowledgedSeq && delivery.deliverySeq <= input.deliverySeq);` / `:840` `const creditedBytes = acknowledged.reduce((total, delivery) => total + delivery.encodedBytes, 0);` / 반환 `:845`. 누적은 `:843` `lane.creditBytes += creditedBytes`. **부수 확인** — `:842` 가 `lane.sent` 를 `> input.deliverySeq` 로 잘라내므로 누적 식대로 구현하면 재계상 대상조차 남지 않는다. 테스트가 못 잡는다는 지적도 사실(`FairTerminalDeliveryScheduler.test.ts:472-479` 는 새 lane 에 ACK 1회) | **§4.2 정산식 블록 전면 재작성**(델타/누적 분리 + 코드 인용 + 두 번째 ACK 지시) · §5 S5-a0 · §13 층 B · 부록 신설 행 |
| **L-1** `:479` 도 `expectedBytes` 를 쓴다 | ✅ 사실. `:478` `assert.deepEqual(ack, { accepted: true, creditedBytes: expectedBytes }, signature);` / **`:479` `assert.equal(scheduler.snapshot().lanes['epoch-a/session-a'].creditBytes, expectedBytes, signature);`**. §7 항목 1 은 이미 둘을 구분하고 있었다 | **§4.2** · §14.2 L-5 행 보강 |
| **L-2** S1 산출물을 "봉투 리터럴(131/128)" 이라 오칭 | ✅ 사실. §7 항목 1 주(`06` 본문)의 처방은 **손으로 적은 봉투 문자열 + `Buffer.byteLength(expectedWire1,'utf8')`** 이고 131 은 `// == 131 when seq1 === 1` 주석에만 나온다. *"맨 숫자로 박으면 하네스 변경에 조용히 깨진다"* 는 같은 주가 스스로 적은 이유다 | **§5 S5-a0 실패 테스트 행** · §13 층 B |
| **L-3** `131` 분해 서술 오류 | ✅ 사실 (직접 계산으로 재확인). `'한글-alpha'` 봉투 = **총 127자 / ASCII 125자 / `한`·`글` 3 B × 2**, 125 + 6 = **131**. `'🙂-beta'` 봉투 = 총 125 code point(UTF-16 code unit 126) / ASCII 124자 / `🙂` 4 B, 124 + 4 = **128**. **결과 131·128 은 정확하고 분해 라벨만 틀렸다** | **§7 항목 1 주** 분해표 |
| **L-4** §1.5 P2 파일 열거 누락 | ✅ 사실. `tools/wave3/canary-admission-evidence.test.mjs` `productionSourcePaths` 는 `:37`~`:56` 이며 **`:52` `frontend/src/components/Terminal/TerminalView.tsx` · `:53` …`/TerminalContainer.tsx`** 가 실재한다. §5 S4-b 가 `TerminalContainer.tsx:3192-3443` 전체 재작성을 지시하므로 06 이 건드리는 파일이 맞다. **매트릭스가 S4 에 P2 ● 를 두므로 단계 배정 영향은 없다**는 finding 의 단서도 정확 | **§1.5 P2 상세표** (`:51` `TerminalRuntimeContext.tsx` 는 편집 대상 미지목이라 제외) |
| **L-5** codec 무관 조항에 프레임 용어 | ✅ 사실. `wsSendPolicy.ts:495` `export interface FairTerminalDeliveryInput {` / **`:499` `payload: string;`** — 구현 피연산자의 필드명이 문자 그대로 `payload` 이고, JSON codec 경로에는 프레임이 없다. 지시 1 이 경계한 함정(`01:51` 의 `payloadLength` = 프롤로그 포함)이 반대 방향으로 남는다 | **§3.1-B S0 지시 2** — 두 함정을 동시에 막는 AC 문면 예시로 교체 · §13 층 A |
| **L-6** §3.1-B 표 1행이 floor 채택 후 미갱신 | ✅ 사실. floor 1 이면 `:701`·`:758` 이 delivery 당 1 B 를 계상하므로 크레딧 원장도 프레임 수를 묶는다. **부수 발견** — 같은 표 2행의 *"`byteLength` … 가 `queueMaxBytes` 예산을 먹는다"* 도 틀렸다: `:758`/`:769` 의 피연산자는 `encodedBytes` 다. 지시 3 의 *"프레임 수 상한은 `byteLength` 도메인 소관"* 은 AC 에 박으면 반증 가능한 계약이 된다 | **§3.1-B 표 1·2·3행** · **S0 지시 3** · §13 층 A · ⚠️ **§5 S5-a 말미가 반영 목록에서 빠져 있었다 — 6차 검증 M-1 이 그 줄을 정정했다** |

> **5차가 "재확인되어 건드리면 안 된다" 고 지목한 항목은 손대지 않았다** — §7 리터럴 131 / 128(봉투 재구성 후 `Buffer.byteLength` 직접 계산으로 재확인), 본문 도메인 12 / 9, `expectedBytes` 21, `screenSeq`·`authorityEpoch`·`authorityRevision`·`chunkId` 생략 서술, `deliverySeq` 자릿수 의존 단서, P3 `--expect-red` 한정, `00:78` 뜻 고정과 C안 기각 사유(`05:202`), 356 vs 250~400 구분, `01:516`/`:518`·`01:611`/`:619` 정정, `visibilityWeight ≡ 8`/`driverWeight ≡ 16` 조건부 불변식과 하한 1024 보증, AC 줄번호(`30.*:3675`~`:3678`), S5-a0 의 shadow 전제(`05:554-562`, `enqueue :750-765`), 3.38× 귀속(142/42), 단계 의존 순서와 §13 층 A 재배치, 매트릭스 S5 행이 P4 를 비운 것.
>
> ⚠️ **다만 4차의 do-not-touch 목록 중 `92/128 ≈ 72%` 는 5차에서 폐기되었다** — 재확인되었던 것은 92 와 356 의 **산수**였지 *"그 둘이 bypass 판정의 피연산자"* 라는 전제가 아니었고, 5차가 코드로 그 전제를 반증했다. §14.2 목록에서 해당 값을 내렸다. **"재조사 제외" 는 숫자의 산수에만 걸리고 그 숫자가 놓인 자리에는 걸리지 않는다** — 다음 라운드도 같은 구분을 지킨다.

### 14.2 독립 검증 **4차** — 전건 반영, **기각 0건**

인용된 `file:line` 을 **전부 직접 열어** 재확인했다. **11건(HIGH 2 · MEDIUM 3 · LOW 6) 중 기각할 것이 없었다.** 반영 위치와 재확인한 사실을 남긴다.

> ⚠️ **라벨 주의 — `M-1`~`M-4` 는 이제 네 패스에 존재한다.** 이 절의 항목은 접미사 없는 **`4차 검증 X-N`** 이고, 본문 인용부도 같은 표기를 쓴다. 선행 패스는 `3차 검증 X-N`(§14.3 주) · `3차 검증-B X-N`(§14.3), 후행 패스는 `5차 검증 X-N`(§14.1)이다.

| finding | 재확인한 사실 (직접 확인) | 반영 위치 |
|---|---|---|
| **H-1** 본문-only `encodedBytes` 결정이 JSON codec 측을 규정하지 않아 `01:728` 기각 근거가 무너짐 | ✅ **전건 사실.** ① `05:204` 원문 = *"payload 바이트는 **인코딩 전환에 불변**이므로 … 크레딧 산수가 단계마다 흔들리지 않는다"* → "불변" 은 **JSON↔바이너리 전환에 대한** 불변이다 ② 그런데 이전 판 §5 S5-a 말미는 *"본문-only 쪽이 창 확대 폭이 더 크고 … 더 강하게 성립"* 이라 적어 **불변을 부정**했다 ③ 현행 구현은 봉투 포함이다 — `wsSendPolicy.ts:598` `function fairDeliveryBytes(...)` → `:599-609` `createWsTransportMessage({type:'output', data: input.payload, …})` → **`:610` `}).byteLength;`** → `:91` `JSON.stringify` / `:95` `Buffer.byteLength(payload,'utf8')` ④ `creditWindowBytes` = `perClientOutputQueueMaxBytes` 는 `TerminalResourcePolicy.ts:57-59`(`:58` `value: outputLimit`) ⑤ 프롤로그-only 프레임은 §4 S2-b F1 대조군(52바이트, `payloadLength=24`)·P7 정정본(`06` 본문)이 **정상 프레임으로 규정**한 것이고 본문-only 에서 크레딧 0 이 된다 | **§3.1-B 신설**(모순 2건 적시 + 두 codec 본문-only + 전환 시점 S5 + floor `max(bodyBytes,1)` + 0B 귀결 처분) · §3.1 `[설계결정]` 불릿 · §3.1-A 기각표 `01:728` 행 · §3.1-A S0 지시 5항 · §4.2 · **§5 S5-a0 신설** · §5 S4-a ② 행 · §5 S5-a 말미(귀속 표) · §5 S0-c · §13 층 A·B · 부록 |
| **H-2** §7 항목 1 의 리터럴 처방(12/9)이 현행 도메인과 어긋나 S1 을 즉시 red 로 만듦 | ✅ **전건 사실.** `FairTerminalDeliveryScheduler.test.ts:467` `const firstWireBytes = encodedOutputBytes('epoch-a','session-a',seq1,'한글-alpha');` / `:213-227` 이 `createWsTransportMessage(...).byteLength` 반환 / `:470`·`:471` 이 그 값을 `sent1.encodedBytes`·`sent2.encodedBytes` 와 대조. **봉투 포함 값이지 payload 바이트가 아니다.** 실측 산출: `'한글-alpha'`(seq 1) → **131 B**, `'🙂-beta'`(seq 2) → **128 B**. `05:213` 예시 자체가 도메인을 오인했고 이전 판이 그 전제를 승계했다. **부수 확인** — 131/128 은 `deliverySeq` 자릿수에 의존하므로 맨 숫자 리터럴은 하네스 변경에 취약하다 | **§7 항목 1 행 + 그 주 전면 개정**(단계별 도메인 표 · 손으로 적은 봉투 문자열 코드 형태 · S5 재교체 지시) · §5 S5-a0 · §13 층 B |
| **M-1** §3.1-A 의 `00:78` 양립 논증이 "단일 domain" 을 두 뜻으로 사용 | ✅ 사실. 앞 문장 = *"서버 원장과 클라이언트 ACK 보고가 둘 다 본문 바이트를 쓰는 한"*(양측 일치) / 뒷 문장 = *"C안은 **와이어 인코딩과 크레딧 도메인**을 영구히 갈라놓는다"*(와이어↔크레딧 일치). 앞 뜻이면 C안(`05:202` — 양측 모두 JSON 바이트)도 `00:78` 을 만족하고, 뒷 뜻이면 본문-only 자신이 위반한다. **`00:78` 원문**(직접 확인) = *"프레임 계약 — `channelId` / `streamEpoch` / `sourceSeq` / payload length / opcode, **ACK credit 은 encoded byte 단일 domain.**"* — "와이어" 도 "프레임 전체" 도 없다 | **§3.1-A `00:78` 양립 절**(뜻 고정 `[설계결정]` + C안 기각 사유를 `05:202` 자신의 문장으로 교체) · §13 층 A |
| **M-2** P3 git-status 게이트가 `--expect-red` 전용인데 세 곳이 무조건으로 서술 | ✅ 사실. `readProductionGitStatus()` `:766` → **유일 호출부 `:816`** → 그 함수 `verifyRedProductionUnchanged()` `:779` → **유일 호출부 `:2522` `const redProductionUnchanged = mode === 'red' ? … : null;`** → `:2470` `const mode = args.includes('--expect-red') ? 'red' : 'green';`. **부수 확인** — 프론트 소스 sha256 핀 `redFrontendSourceBaseline`(`:129`)도 같은 함수 안(`:804-805`)이라 **동일하게 red 전용**이다. `06` §1.5 P3 상세(`발동 조건` 행)는 이미 정확했고 §2.1·§3·§13 이 조건을 떨어뜨렸다 | **§1.5 P3 상세 git 의존 행** · §2.1 범위 한정 표 P3 행 + 그 아래 분기 목록 · **§3 D6 주의 전면 재작성**(마감 2종) · §3.2 D6 행 · §13 층 B |
| **M-3** S0-c 의 *"S5 재조정 대상 = 정책 키 9개"* 가 §5 S5-a 확정 결론과 어긋남 | ✅ 사실. §5 S5-a 결론 = *"9개 재측정이 아니라 **바이트 5개 재측정 + 비율/문자열 4개 재귀속**"*. `visibilityWeight`(`TerminalResourcePolicy.ts:49-51`) · `driverWeight`(`:53-55`)는 `config.schema.ts:124-125` 의 하한 **1024**(`bytesLimit(1024, …)`) 때문에 스키마가 통과시키는 모든 구성에서 8/16 고정 → **값이 움직일 수 없다.** `PERF-BGSTAB-010` AC-4(`30.*:3676`, 직접 인용)는 *"Scheduling strategy, socket soft gate, bulk slice, small-output bypass, visibility/driver weight와 credit window"* **7개**만 명시하므로 "9" 는 AC-4 와도 어긋난다 | **§5 S0-c 해당 행 전면 교체**(저작 문면 제시 + "5개" 로도 쓰지 말 것) |
| **L-1** §5 S5-a #4 와 §10.3 이 같은 40B 예시에 다른 JSON 크기 | ✅ 사실. `02:267-268` 의 250~400 은 **봉투 고정 오버헤드**(*"JSON output 프레임 1개의 **고정 오버헤드** [추정]"*), `02:366` 의 356 은 **40B 청크의 총 프레임**(*"라이브 output 청크 40 B … ≈ **356 B**"*). 92B 와 대조할 층위는 후자다. 3차-B 정정이 바이너리 쪽(61→92)만 고치고 JSON 쪽 `≈300` 을 남겨 정정 후에도 불일치가 존속했다. **결론(판정 뒤집힘)은 356 으로 바꿔도 불변** — 356 > 128 | **§5 S5-a #4 주**(두 출처 구분 표 + 피연산자 356 으로 교체) |
| **L-2** `'🙂-beta' → 9` 의 `[추정]` 불필요 | ✅ 사실. `U+1F642`=4B + `-`=1B + `beta`=4B = **9**, 결정적이다(직접 계산으로 확인). 같은 문장의 `'한글-alpha' → 12` 를 확정으로 쓰면서 이쪽만 추정으로 둔 것은 근거 없는 비대칭. **단 H-2 대로 두 값 모두 S1 이 아니라 S5 도메인의 값이다** | **§7 항목 1 주**(마커 제거 + S5 행 귀속) |
| **L-3** `01:516` 인용 오차 | ✅ 사실. `01:516` = `#### 0x02 SCREEN_SNAPSHOT (프롤로그 24B)` (제목), *"본문은 원시 ANSI UTF-8"* 은 **`01:518`**. 프롤로그 24B 산수 자체는 옳다 — `8+2+2+1+1+2+4+2+2 = 24`(`01:518`) | **§4 S2-b F5 주** |
| **L-4** `01:619` 인용 오차 | ✅ 사실. **`01:611`** = *"서버는 `WebSocketServer` 생성 시(`WsRouter.ts:612`) `handleProtocols` 를 준다. 선택 결과는 `ws.protocol` 로 양쪽이 읽는다"* / **`01:619`** = *"현재 두 소켓 생성 지점 모두 subprotocol 인자를 쓰지 않는다(`WebSocketContext.tsx:1201`, `:1007`). 인자 추가가 전부다"* — **클라이언트 측 서술**. 같은 표의 클라이언트 두 행이 `:619` 를 인용하는 것은 **옳으므로 손대지 않았다** | **§5 S3 subprotocol 표 서버 행** |
| **L-5** §4.2 확정식이 per-delivery 필드를 배치 합으로 정의 | ✅ 사실. `encodedBytes` 는 `FairTerminalDelivery`(`wsSendPolicy.ts:508`)의 필드로 **`:510`** 에 선언된 **delivery 단위** 값이고 §3.1 도 그렇게 인용한다. 배치 합은 누적 ACK 정산 총액이며 테스트도 그렇게 다룬다 — `FairTerminalDeliveryScheduler.test.ts:469` `const expectedBytes = firstWireBytes + secondWireBytes;`. ⚠️ **5차 L-1 보강: 그 값을 쓰는 곳은 `:478` `creditedBytes` 하나가 아니라 `:479` `creditBytes` 까지 둘이다** (그리고 5차 M-3 대로 두 단정은 서로 다른 값을 보는데 `lastAcknowledgedSeq === 0` 이라 우연히 같다). `byteLength`(WS 메시지 단위, `01:1429`)와 나란히 Σ 로 적히면 §3.1-A 지시 3 이 경고한 오독 경로가 그대로 열린다 | **§4.2 확정식 블록**(층위 주석 + `creditedBytes` 이름 분리) · 부록 |
| **L-6** §13 층 A 가 D 결정을 Q2 앞에 둠 | ✅ 사실. **`04:598`** = *"`wsTransportMode` 와 별개인 `realtime.terminalWireFormat` 키 신설에 동의하는가?"* 이고 이것이 Q2(`06` §3.4)다. **D12(4값 사다리)와 D3(codec × mode)는 그 키의 존재를 전제**하므로 Q2 거부 시 D12 는 무효, D3 는 형태가 바뀐다. §3 층 A 표는 순서를 규정하지 않으므로 이 문제는 §13 에만 있다 | **§13 층 A 순서 재배치**(Q1~Q6 → D1·D2·D5·D10·D11 → D3·D12) |

> **4차 검증이 "재확인되어 건드리면 안 된다" 고 지목한 항목은 손대지 않았다** — 28B 산수 전건(헤더 28 / OUTPUT·SNAPSHOT 프롤로그 24 / CHECKPOINT_CHUNK 12 / 세그먼트 16 / 최소 유효 OUTPUT 52·`payloadLength=24` / F2 142·152·153 / F5 2097152→`payloadLength` 2097176 및 세 점 / 40B·52B 고정비 / `1-92/356≈74%` / ~~`92/128≈72%`~~ / `3.38×` vs `4.38×` / `78=42+36` / `4194304/512=8192` / trace 22호출·21에지 / silent-drop 7+1=8 / opcode 10+2=12), `visibilityWeight`·`driverWeight` 조건부 불변식과 하한 1024 보증, **핀 3표(매트릭스·상세표·단계별 행)의 일치**, 스위트 수치 전건(37/56/30/2/22, ws 7, server tools 2), §14.4 의 L-3 기각. **이 목록은 다음 라운드의 재조사 제외 대상이다.**
>
> ⚠️ **`92/128 ≈ 72%` 는 5차에서 취소선 처리했다** — 92 와 356 의 산수는 여전히 옳지만, 그 둘이 `smallOutputBypassBytes` 판정의 피연산자라는 **전제가 코드로 반증**되었다(`wsSendPolicy.ts:703`·`:716` = `delivery.encodedBytes`). 상세는 §14.1 H-1.

### 14.3 독립 검증 **3차-B** — 전건 반영, **기각 0건**

인용된 `file:line` 을 **전부 직접 열어** 재확인했다. **13건 중 기각할 것이 없었다.** 반영 위치와 재확인한 사실을 남긴다 — 다음 라운드가 같은 것을 다시 파헤치지 않게 하기 위함이다.

> ⚠️ **라벨 주의 — "3차" 를 자칭하는 독립 검증 패스가 둘이고 항목 번호가 겹친다.**
>
> | 패스 | 본문 라벨 | 항목 | 기록 위치 |
> |---|---|---|---|
> | 3차 선행 | **`3차 검증 X-N`** (접미사 없음) | H-2 · M-1 · M-3 · M-4 · M-5 · M-6 | §0 개정 요약 **14~16행** + 각 인용부 |
> | 3차 후행 | **`3차 검증-B X-N`** | H-1 · M-1~M-4 · L-1~L-8 | §0 개정 요약 **17~21행** + **아래 표** |
> | 4차 | **`4차 검증 X-N`** | H-1 · H-2 · M-1~M-3 · L-1~L-6 | §0 개정 요약 **22~27행** + **§14.2** |
> | 5차 | **`5차 검증 X-N`** | H-1 · M-1~M-3 · L-1~L-6 | §0 개정 요약 **28~34행** + **§14.1** |
> | **최신** | **`6차 검증 X-N`** | H-1~H-3 · M-1·M-2 · L-1~L-4 | §0 개정 요약 **35~40행** + **§14.0** |
>
> **`M-1` · `M-3` · `M-4` 는 다섯 패스에 걸쳐 존재하고 내용이 전혀 다르다** — 예: `3차 M-4` = F9 rejection code, `3차-B M-4` = `visibilityWeight` 불변식, `4차 M-3` = S0-c 의 "9개" 지시, `5차 M-3` = `creditedBytes` 델타/누적, `6차 M-1` = §5 S5-a 말미의 배타적 소관. **접미사 없이 `3차 검증 M-4` 라 쓰인 곳은 3차 선행 항목이고, `4차 검증 M-N` 은 §14.2, `5차 검증 M-N` 은 §14.1, `6차 검증 M-N` 은 §14.0 항목이다.** 이 표 아래 본문의 항목은 전부 `-B` 다.

| finding | 재확인한 사실 (직접 확인) | 반영 위치 |
|---|---|---|
| **H-1** `encodedBytes` 도메인이 세 정본과 충돌하는데 문서에 그 사실이 없음 | ✅ **전건 사실.** `01:728` = *"바이너리 그룹에서 `encodedBytes` 는 바이너리 프레임 전체 길이(28 + 프롤로그 + 본문) 로 재정의한다. 배치면 배치 전체 길이다"* `[설계결정]` / `02:243` = `encodedBytes (fair)` 를 `21 + payload.byteLength`(헤더 포함) 로 규정 / `00:78` = §3 "무효화하지 않는 것" 의 *"ACK credit 은 encoded byte 단일 domain"*. 이전 판에서 이 세 줄의 인용 횟수는 **전수 grep 0회**. 그리고 `01:732` 는 `01:730`(*"이 변경의 파급이 크므로 명시한다:"*) 아래 1번 항목이므로 **`01:728` 의 귀결이 맞다** | **§3.1-A 신설**(기각 표 + `00:78` 양립 논증 + S0 저작 지시 4항) · §4.2 · §5 S5-a `01:732` 인용부 · §13 층 A |
| **M-1** `byteLength` 식이 프레임 1개용 | ✅ 사실. `WsRouter.ts:6098` = `bufferedAmount + message.byteLength` (WS 메시지 단위) / `01:459` = *"1 WS 메시지 = N 논리 프레임"* / **`01:1429` = `byteLength: out.length` 이고 `out` 은 `01:1402` 에서 배치마다 새로 만드는 `GrowableBuffer`** → Σ(프레임)이 정본. **P2 자체는 단일 프레임 property 라 옳다**는 finding 의 단서도 정확 | **§4.2 배치 정정** (확정식 2줄) |
| **M-2** 핀 상세표 3개가 매트릭스와 어긋남 | ✅ 사실. P1 상세 `S1·S4·S5·S6` vs 매트릭스 + S2.5·S3 / P2 상세 `S1~S5` vs 매트릭스 + S2.5·S6 / P4 상세 `S1·S3·S4` vs 매트릭스 + S2.5. **P3·P5 는 일치**한다는 것도 확인 | **§1.5 P1·P2·P4 상세표** + 매트릭스 뒤 "세 표 동시 갱신" 규칙 |
| **M-3** F5 2 MiB 의 도메인 미지정 | ✅ 사실. `config.schema.ts:77` = `maxSnapshotBytes ?? maxBufferSize ?? 2097152` (PTY **데이터** 상한) / `01:516` = SCREEN_SNAPSHOT 프롤로그 **24B** → `payloadLength` 와 `bodyBytes` 가 **정확히 24B 차이** | **§4 S2-b F5 행 + F5 주** (`bodyBytes` 도메인 `[설계결정]`) |
| **M-4** `≡8`/`≡16` 이 무조건 항등식이 아님 | ✅ 사실. `TerminalResourcePolicy.ts:34`/`:50`/`:54` 원문 확인. `L=20→10` · `L=27→9` · `L=15→15` · `L=7→7` 반례 재현. `driverWeight` 분모 `outputLimit/16` 은 **floor 되지 않은 부동소수**. ⚠️ **finding 의 요청대로 기본값을 확인한 결과가 더 강했다** — `config.schema.ts:124-125` 가 하한 **1024** 를 강제하므로 **스키마가 통과시키는 모든 구성에서 8/16** 이다. 결론(재귀속만)은 유지되나 근거가 "함수의 항등성" 이 아니라 "스키마의 하한" 으로 바뀐다 | **§5 S5-a #5·#6 주** (조건 + 보증 근거) · §13 층 B |
| **L-1** §5 S5-a #4 가 21B 수치를 무단서 인용 | ✅ 사실. `02:270` = *"고정 오버헤드 = 21 바이트"* / `02:272` = 61B. §10.3 은 같은 40B 예시를 92B 로 재계산해 놓고 여기선 무단서였다 | **§5 S5-a #4 주** (+ 기본값에서는 뒤집힘이 관측되지 않는다는 `[추정]` 추가) |
| **L-2** "(또는 프롤로그 포함 52B)" 를 표 전체에 적용 불가 | ✅ 사실. `01:522` = `0x05 CHECKPOINT_CHUNK` 프롤로그 **12B** → checkpoint 행 고정비는 **40B** | **§10.3 정정 3번** (opcode 별 고정비 표) |
| **L-3** 그룹 8 이 server tools 1/2 만 실음 | ✅ 사실. `ls server/tools` → `*.test.*` **2개**. `ensure-node-pty-windows-hide.test.cjs` 는 `require('node:test')` 확인 | **§5 S-1 그룹 8** · §13 층 A |
| **L-4** `:1413` 은 `computedIncomingBytes` 가 아님 | ✅ 사실. 전수 grep → `:1370`·`:1383`·`:1421` 3곳. `:1413` 은 `const incomingBytes = …`. **실질(vacuity)은 옳고 이름만 틀림** | **§4.3 vacuity 표 2행** |
| **L-5** `:411` 은 `} catch {` | ✅ 사실. 주석 *"Non-JSON terminal output is not production-path evidence."* 는 `:412` | **§5 S3 표 6행** |
| **L-6** 캡션은 `01:41` | ✅ 사실. `01:40` 은 빈 줄 | **§4 S2-b 산수 표 도입문** |
| **L-7** `01:81` 조건을 뒤집어 옮김 | ✅ 사실. 원문은 *"(프롤로그를) **실은 채로 비트만 지우면** 디코더가 프롤로그를 본문으로 오독한다"*. **부수 확인** — 이 사례(프롤로그 실림 + 플래그 꺼짐) 전용 rejection code 가 `01:934-943` 10종에 없고, `mandatory-flag-not-accepted`(`01:673`)는 **협상 실패 사유**이지 프레임 거부 코드가 아니다 → F9 주와 같은 구조적 공백으로 등재 | **§4 S2-b "28바이트 헤더만" 주** (조건 복원 + `[미확인]` 등재) |
| **L-8** §6 층 1 이 S3 에 배정됐으나 §S3 목록에 없음 | ✅ 사실. `WsRouter.ts:612` = `new WebSocketServer({ noServer: true })` (**P1 핀 파일**) / `WebSocketContext.tsx:1201`·`:1007` = subprotocol 인자 없는 `new WebSocket(...)` | **§5 S3 "subprotocol 협상" 소절 신설** + 핀 영향·검증 커맨드 갱신 · §6 층 1 역참조 · §13 층 B |

> **3차 검증-B 가 "정확하다고 재확인" 한 항목은 손대지 않았다** — §2.3 의 `05` 21B 오염 전수 목록, F1~F11·P2·P7·§10.1·§10.3·§4.5·§S4-b 의 28B 재작성, 헤더 합 28 / 프롤로그 24 / 세그먼트 16 / 최소 유효 프레임 52(`payloadLength=24`), F2 의 142/152/153, `1-92/356≈74%`, `142/42=3.38×` vs `184/42=4.38×`, `'한글-alpha'=12`, `4194304/512=8192`, trace 22호출/21에지, silent-drop 7+1=8, opcode 10+2=12, 스위트 수치 전건(37/56/30/2/22 및 ws 7). **이 목록은 다음 라운드의 재조사 제외 대상이다.**

### 14.4 독립 검증 **2차** — 기각한 finding

독립 검증 2차의 지적 중 **재확인 결과 지적이 틀린 것 1건**이다. 반영하지 않고 사유를 남긴다.

| finding | 지적 내용 | 재확인 결과 |
|---|---|---|
| **L-3** | *"`webSocketUrl.ts:80` 을 output 의 `mode=` 라 했으나 `:80` 은 `channel: 'output'` 이고 `mode: 'split'` 은 `:79` 다"* | ❌ **기각.** `frontend/src/utils/webSocketUrl.ts` 를 직접 열어 확인한 결과 `buildSplitOutputWebSocketUrl` 의 `URLSearchParams` 리터럴은 **`:78` `const params = new URLSearchParams({` / `:79` `token: token \|\| '',` / `:80` `mode: 'split',` / `:81` `channel: 'output',`** 이다. **`:80` 이 `mode: 'split'` 이 맞고 계획서 §1.1 의 인용이 정확하다.** finding 이 `:79`/`:80`/`:81` 을 한 칸씩 당겨 읽었다 |

**§1.1 의 관련 서술은 원문을 유지한다**: 프론트는 쿼리 파라미터를 `mode=` 로 보내고(`webSocketUrl.ts:58` control, **`:80` output**) 서버는 `wsTransportMode=` 를 읽는다(`WsRouter.ts:1542`) — **이름 불일치는 여전히 실재**하며, 이것이 §1.1 의 "split 은 프로덕션에서 도달 불가능" 논거 중 하나다.

> 사실 위조는 검증 통과보다 위험하므로, 근거 없이 finding 을 수용해 정확한 인용을 틀린 값으로 바꾸지 않았다.

✅ **독립 검증 3차·3차-B·4차·5차가 이 기각을 각각 재확인했다** (5차까지 **네 번째 재확인**) — *"§14 의 L-3 기각 기록(`webSocketUrl.ts:78-81`) — **기각이 옳다고 재확인됨**"*. 이 행은 **유지하며, 이후 라운드의 재조사 제외 대상이다.**

---

## 부록 — 정본 위치 색인

| 주제 | 정본 |
|---|---|
| 프레임 바이트 레이아웃 · flags · 프롤로그 | `01` §1.1–§1.8, 부록 A |
| 디코더 의사코드 · rejection code · 오류 등급 | `01` §3.4, `01:934-958`, 부록 B |
| 인코더 · 배치 조립기 · 채널 할당기 의사코드 | `01` 부록 B2 (`01:1387-1395` 헤더 write, `01:1400-1404` `flushBatch` — **배치마다 `new GrowableBuffer()`**) |
| 협상 메시지 스키마 — **인터페이스 5개 / distinct type 4개** | `01:638-690` (§3.3 D10 주) |
| 롤백 상태 전이도 · 3중 방어 | `01` §4.2, §4.4 |
| 서버 개입 지점 7개 · 마스터 변경 지점 표 | `02` §1, §8 |
| 클라이언트 변경 지점 표 (필수/조건부/제외) | `03` §11 |
| SRS mutation 시퀀스 (Phase 0–8) | `04` §5 |
| 테스트 영향 전수 | `05` §3 |
| **fault 경계 대조군** | **종류·논리는 `05` §6.3, 숫자·오류코드는 이 문서 §4 S2-b (28B 정정본).** `05` 는 21B 초안 기반이다 — §2.3 |
| **rejection code 전수 (10종)** | `01:934-943` (표 헤더 `:932`, 구분선 `:933`). ⚠️ **공백 2건** — `frameVersion` `0x00`/`0xFF` 전용 코드 없음(§4 S2-b F9 주) · `PROLOGUE_PRESENT` 누락 전용 코드 없음(§4 S2-b L-7 주). 둘 다 S2 착수 전 처분 |
| **`encodedBytes` 회계 도메인** | ⚠️ **`01:728`·`02:243` 이 아니라 이 문서 §3.1-A + §3.1-B 다.** 두 정본은 명시 기각되었고 사유는 §3.1-A 가, **그 사유가 성립하기 위한 전제(JSON codec 도 본문-only, 전환 시점 S5-a0, floor 1)는 §3.1-B** 가 보유한다. `00:78`(단일 domain 요건)은 유효하며 그 뜻은 **"서버 원장 ↔ 클라이언트 ACK 보고 일치"** 로 고정했다 — 본문-only 가 그것을 만족한다. **현행 구현은 봉투 포함**(`wsSendPolicy.ts:598-611` → `:91`/`:95`)이므로 전환 대상이다 |
| **`byteLength` 회계 도메인 (배치 포함)** | `01:1429` `byteLength: out.length` + 이 문서 §4.2 확정식. **프레임 1개 식이 아니다.** ⚠️ 그리고 `encodedBytes` 와 **층위가 다르다** — `byteLength` 는 WS 메시지 단위, `encodedBytes` 는 delivery 단위(`wsSendPolicy.ts:510`). 배치 합 형태로 나란히 적지 않는다 (§4.2, 4차 L-5). ⚠️ **정책 9키 중 `byteLength` 를 먹는 것은 하나도 없다** — `queueMaxBytes`(`:758`)·`creditWindowBytes`(`:701`)·`socketSoftGateBytes`(`:702`)·`smallOutputBypassBytes`(`:703`/`:716`/`:738`)는 전부 **`encodedBytes` 도메인**이다 (5차 H-1). `byteLength` 를 먹는 것은 `WsRouter` 쪽이며 **게이트가 하나가 아니다** (7차 H-1) — `wsSendMode='safe-send-*'` 에서는 `:6098-6099` 백프레셔 게이트, 기본 `'direct'` 에서는 `:6169`·`:6182` 출력 큐 상한이다 |
| **ACK 정산 값 두 종** | `creditedBytes`(ACK 1회 반환값) = **직전 ACK 이후 델타**, `wsSendPolicy.ts:839-840` → 반환 `:845` / `lane.creditBytes` = **누적 총액**, `:843`. **누적 식으로 `creditedBytes` 를 정의하면 두 번째 ACK 부터 중복 계상**된다 (§4.2, 5차 M-3). 테스트 `FairTerminalDeliveryScheduler.test.ts:478`(델타)·`:479`(누적)는 `lastAcknowledgedSeq === 0` 이라 두 값이 우연히 같다 |
| 회귀 전수 커맨드 | `05` §5.3 |
| 마이그레이션 사다리 4단계 | `05` §8.2 |
| 롤백 드릴 R1–R7 | `05` §9.2 |
| **`smallOutputBypassBytes` 판정의 피연산자** | ⚠️ **`delivery.encodedBytes` 뿐이다** — `wsSendPolicy.ts:703`·`:716`·`:738`. 프레임 고정비(28/52)도, 와이어 프레임 크기(92/356)도 들어가지 않는다 (5차 H-1 · **6차 H-2**). 그리고 `:702` soft gate 가지는 **`socketSoftGateBytes ≥ creditWindowBytes` 인 구성에서 사문**이다 — `:701` 이 먼저 `socketQueuedBytes < creditWindowBytes` 를 보장하기 때문이며, **저한도 회귀 구성(12,288 ≥ 4,096)과 스키마 기본값(8,388,608 ≥ 2,097,152) 둘 다 그 경우다** (6차 H-1) |
| **delivery 수 상한의 소관** | ⚠️ **두 도메인이 각각 준다. 우열은 구성 의존이다** (6차 H-3). ① `encodedBytes` 도메인 — `creditWindowBytes`(`:701`) = `perClientOutputQueueMaxBytes`, 기본 2,097,152 / ② `byteLength` 도메인 — `serverBufferedHardLimitBytes`(`WsRouter.ts:6098-6099`), 기본 33,554,432. `config.schema.ts:127-135` `superRefine` 은 두 키 관계를 제약하지 않으므로 **어느 쪽이 먼저 걸리는지는 무조건 명제가 아니다.** ⚠️ **그리고 ②를 그 키로 지목하는 것 자체가 `wsSendMode` 종속이다** (7차 H-1) — 기본 `'direct'`(`config.schema.ts:201`)에서는 `:6086-6094` 의 early return 때문에 `:6098-6099` 가 미도달이고, 그 모드의 `byteLength` 상한은 `:6169`·`:6182`(상한값 `:6158` → `:5761-5763` `perClientOutputQueueMaxBytes`)가 준다. **AC 에는 도메인 이름만 적고 설정 키를 박지 않는다** |

---

## 착수 가능 여부

**착수 가능 — 단 무조건이 아니다.** 계획서 자체의 결함은 **7차**까지의 검증으로 해소되었고 이번 판에서 남은 사실 오류는 없다(§14.0-A, 기각 0건 — HIGH 1 은 `IR-BGSTAB-001` AC 문면을 **도메인 수준**으로 되돌려 `wsSendMode` 종속에 무너지지 않게 했고, MEDIUM 1 은 S5-a0 `:738-739` 축의 vacuous 한 관측을 **경쟁 lane 순서 단정**으로 교체했다). **그러나 착수는 §13 층 A 하드 게이트 — Q1~Q6 사용자 결정(특히 **Q2** `realtime.terminalWireFormat` 키 신설) → D1(§3.1 + **§3.1-A 기각 기록** + **§3.1-B JSON codec 규정**) · D2 · D5 · D10 · D11 → Q2 승인 후 D3 · D12 → S0 SRS 저작 → **S0.5 provenance republish 리허설 성공** — 을 전부 통과한 뒤에만 가능하다.** 그중 **S0.5 가 실패하면 착수 불가**이며(§1.5 결론 — republish CLI 가 저장소에 없다, `05:293-297`), Q2 가 거부되면 D12 는 무효·D3 는 형태가 바뀌므로 층 A 를 다시 돈다. **코드 첫 저장은 S0.5 성공 이후 S1 부터**다.
