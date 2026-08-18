# 결정 기록 — 바이너리 데이터 플레인 무조건 도입

| 항목 | 값 |
|---|---|
| 결정일 | 2026-08-16 |
| 결정 주체 | 사용자 (프로젝트 오너) |
| 결정 | WebSocket terminal data plane 을 JSON 에서 **바이너리 프레임으로 전환한다. 즉시 착수한다.** |
| 성격 | 조건부 → **무조건**. 선행 측정 게이트 폐기 |
| 이 문서의 지위 | 아래 §2 에 열거된 모든 게이트·보류·금지 조항에 대해 **상위 결정** |

---

## 1. 결정 내용

터미널 출력 전송을 versioned binary frame 으로 전환한다. 다음 두 가지는 이 결정으로 확정된다.

1. **control 평면은 JSON 을 유지**하고, **terminal output / snapshot 평면만** 바이너리로 전환한다.
2. 도입 여부를 판정하기 위한 **선행 측정은 착수 조건이 아니다.** 측정은 여전히 수행하되, 그 목적은 *도입 여부 판정*이 아니라 *전환 전후 비교와 회귀 감시*다.

## 2. 이 결정이 무효화하는 것

아래 조항들은 모두 "측정 후 조건부 도입" 전제 위에 세워져 있었다. 그 전제가 사라졌으므로 함께 무효화된다.

### 2.1 도입 게이트 (폐기)

`docs/issues/wave4-wave5/19-binary-data-plane.md` 의 완료 조건에 있던 AND 게이트 2개:

> 1. JSON stringify/parse/UTF-8 재인코딩이 profile에서 유의미한 CPU 비중이어야 한다.
> 2. fair scheduler만으로 control HOL과 echo SLO를 만족하지 못해야 한다.

**폐기.** 두 게이트의 임계값은 어느 것도 숫자로 확정된 적이 없었고(임계값 미정, echo SLO 미확정), 따라서 이 게이트는 판정 가능한 조건이 아니라 무기한 보류 장치로 기능하고 있었다.

동시에 폐기되는 것:
- 2단계 판정표의 4개 조합 중 3개가 "미채택"으로 가던 분기
- `explicitly skipped/not adopted` 종료 경로
- "미채택 분기에는 의미 없는 failing TDD 를 만들지 않는다"는 예외 조항 — 이제 채택 분기만 존재하므로 **TDD 는 통상대로 전면 적용**된다

### 2.2 보류 결정 (해제)

| 위치 | 기존 | 변경 |
|---|---|---|
| `docs/research/2026-07-15.orca-buildergate-multisession-performance-fact-check-and-plan.ko.md` 결정표 | `binary protocol 즉시 도입 \| 보류` | **채택** |
| 같은 문서 우선순위표 | `P2 조건부 \| binary terminal data plane` | **P0 무조건** |
| `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md` Phase 9 | 측정 게이트 조건부 | **무조건 착수** |

### 2.3 후행 이슈의 대기 조건 (해제)

- `#20` — "binary/socket consumer 칸은 #19 가 `adopted` 일 때만 채운다. `skipped` 면 skip 증거 링크를 건다" → **adopted 확정**이므로 skip 분기 삭제
- `#21` — "`#19 adopted 완료` 또는 `evidence-backed explicitly skipped` 중 하나로 결론이 나야 시작" → **adopted 로 결론남**

### 2.4 SRS 제약 (개정 대상)

아래는 이 결정에 따라 개정되어야 한다. 구체안은 `04-srs-amendment-plan.md` 를 따른다.

| 대상 | Stability | 차단 내용 |
|---|---|---|
| `docs/spec/30.buildergate-stability.srs.md:27` | (Scope) | Out of Scope: "Making split WebSocket the default transport." |
| `docs/spec/40.mcp-session-orchestration.srs.md:27` | (Scope) | Out of Scope: split 기본화 + "changing existing WebSocket protocol compatibility" |
| `REL-BGSTAB-007` AC-4 | **stable** | Ordinal64 를 "JSON wire 에서는 canonical unsigned decimal string 으로만" 고정 |
| `REL-BGSTAB-007` AC-11 | **stable** | "WebGL/binary/split 기본화를 자동 승인하지 않는다" |
| `FR-BGSTAB-001` AC-3 | **stable** | `wsTransportMode` enum 이 `unified\|split-shadow\|split` 로 닫힘 |
| `FR-BGSTAB-006` / `FR-BGSTAB-007` | **stable** | 소켓 짝 핸드셰이크·라우팅 계약 |
| `FR-BGSTAB-008` AC-5 | **stable** | `/api/runtime-config` 허용목록 |
| `FR-BGSTAB-012` | **stable** | 큐 예산이 UTF-8 byte 단위 |
| `PERF-BGSTAB-009` AC-7 | evolving | "Production ingress 는 string 을 유지 … binary WebSocket 을 변경하지 않는다" |
| `PERF-BGSTAB-010` | evolving | 알고리즘·숫자를 "JSON encoding" 조건에 맞춰 확정 → 재벤치 필요 |
| `FR-BGSTAB-016` AC-3/4 | evolving | `bufferedAmount + payload bytes` 게이팅, byte limit 병합 |
| `REL-BGSTAB-003` | evolving | replay 가 string-tail 기반 |
| `REL-BGSTAB-006` AC-5 | evolving | split disposition 을 `unresolved` 로 유지 + split runtime 활성화 금지 |

**AC-11 에 관한 주석**: 이 조항은 binary 기본화를 *금지*한 것이 아니라 *자동 승인*을 금지한 것이다. 원문이 요구한 것은 "별도 Requirement, TDD, rollout evidence와 **사용자 승인**"이며, 이 문서가 그 사용자 승인에 해당한다. 나머지 세 요건(별도 Requirement / TDD / rollout evidence)은 면제되지 않으며 그대로 이행한다.

## 3. 이 결정이 무효화하지 **않는** 것

다음은 그대로 유지된다. 게이트 폐기는 품질 요건 면제가 아니다.

- **TDD 전면 적용** — 모든 동작 변경은 실패 테스트 선행. §2.1 의 예외 조항은 미채택 분기 전용이었으므로 소멸했고, 남은 것은 통상 규칙뿐이다.
- **프레임 계약** — `channelId` / `streamEpoch` / `sourceSeq` / payload length / opcode, ACK credit 은 encoded byte 단일 domain.
- **혼합 버전 안전성** — 해석 불가 프레임의 silent drop 금지. JSON snapshot downgrade 또는 명시적 reconnect 로 수렴.
- **롤백 계약** — binary epoch 종료 → 재협상 → JSON fresh snapshot. **binary 큐를 JSON 으로 재해석하지 않는다.**
- **split pair authentication 과 소켓별 독립 reconnect.**
- **SRS 선행 원칙** — 런타임 코드 전에 요구사항이 있어야 한다. wave-5 는 현재 요구사항 0건이므로 신규 저작이 선행한다.
- **측정** — 게이트로서는 폐기됐으나 전후 비교·회귀 감시용으로는 수행한다.

## 4. 남은 선행 작업

게이트가 사라져도 **기술적 선행**은 남는다. 이것은 승인 조건이 아니라 작업 순서다.

| 항목 | 왜 선행인가 |
|---|---|
| `#3` split 계약 drift 종결 (`REL-BGSTAB-006` disposition) | 바이너리 프레임이 split 소켓 위에서 짝 인증을 해야 하는데, 계약과 런타임이 어긋난 상태에서는 무엇에 맞출지 정할 수 없다 |
| wave-5 SRS 신규 저작 | 요구사항 0건 상태에서는 구현이 blocked |
| `FR-BGSTAB-017` recovery write gate | fact-check 문서 `:265` — "현재 snapshot/repair write 일부는 live scheduler 를 우회한다. 따라서 recovery write gate 가 binary 보다 먼저다" |

## 5. 기록된 반대 근거 (참고용, 결정을 뒤집지 않음)

이 결정과 배치되는 저장소 내 감사 결과가 존재한다. 삭제하지 않고 여기 기록해 둔다 — 나중에 "왜 그때 이렇게 정했나"를 되짚을 수 있어야 하기 때문이다.

`docs/research/2026-07-15.orca-buildergate-multisession-performance-fact-check-and-plan.ko.md` 는 Orca 공식 소스를 커밋 `e0edc8e` 로 고정해 감사했고 다음을 확인했다.

- `:336` — `| binary stream protocol | 거짓 | control과 stream 모두 현행 코드에서는 UTF-8 NDJSON/JSON 문자열이다. |`
- `:30` — "Orca는 현재 binary data plane이나 DRR을 사용하지 않는다."
- `:370` — "Orca가 binary를 쓴다는 전제"를 *복사하지 않을 항목*으로 분류

즉 **"Orca IDE 처럼 바이너리로"라는 동기는 사실 관계가 성립하지 않는다.** Orca 가 실제로 쓰는 것은 control/stream 소켓 분리 + role pairing + shallow gate + keep-tail 이며, 전부 JSON/NDJSON 위에서 동작한다.

이 사실을 사용자에게 보고했고, 사용자는 그럼에도 바이너리 전환을 지시했다. 따라서 이 전환의 근거는 "Orca 가 그렇게 한다"가 아니라 **프로젝트 오너의 설계 결정**이다. 성능 개선 여부는 도입 후 측정으로 확인한다.
