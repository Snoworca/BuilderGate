# 터미널 데이터를 JSON 대신 바이너리로 보내기

> 원문 제목: `[Orca][P9] split/binary data plane 측정 gate와 조건부 도입`
> 원본 이슈: `Snoworca/BuilderGate#19` — https://github.com/Snoworca/BuilderGate/issues/19
>
> ⚠️ **2026-08-16 개정**: 이 이슈는 더 이상 조건부가 아니다. 도입 게이트 2개는 **폐기**됐고 바이너리 전환은 **무조건 착수**로 확정됐다. 근거와 무효화 범위는 `docs/research/binary-comms/00-decision-record.md` 를 따른다. 아래 본문에서 게이트·판정·미채택 분기에 관한 서술은 이력으로만 남긴다.

## 한 줄 요약

터미널 출력 전송을 JSON에서 versioned binary frame 으로 전환한다. control 평면은 JSON 을 유지하고 output/snapshot 평면만 바꾼다. **착수 조건은 없다** — 측정은 도입 판정용이 아니라 전후 비교·회귀 감시용으로 수행한다.

## 지금 무슨 문제가 있나요?

지금 BuilderGate는 서버의 PTY(진짜 셸 프로세스)가 뱉은 출력을 **JSON 문자열로 감싸서** WebSocket으로 브라우저에 보낸다. 이 과정에는 서버에서 `JSON.stringify`, 브라우저에서 `JSON.parse`, 그리고 바이트 수를 세기 위한 UTF-8 재인코딩이 매번 들어간다. 예를 들어 `frontend/src/utils/terminalOutputHotPath.ts:12` 는 출력 청크마다 `outputTextEncoder.encode(raw).length` 로 바이트 길이를 다시 계산하고, `frontend/src/components/Terminal/TerminalView.tsx:589` 도 같은 방식으로 큐 바이트를 센다. 서버 쪽 전송 정책은 `server/src/ws/wsSendPolicy.ts` 에 있다.

문제는 **"이게 실제로 느림의 원인인지 아무도 모른다"** 는 것이다. 컴파일러가 느린 것 같아서 SSD를 바꾸는 상황일 수도 있다. 후보 원인은 최소 두 개다.

1. JSON 인코딩/디코딩과 UTF-8 재인코딩이 CPU를 많이 먹는다 → 바이너리 프레임이 답일 수 있다.
2. 출력이 폭주할 때 제어 메시지(키 입력 ACK, 리사이즈 등)가 그 뒤에 줄을 서서 늦어진다(= HOL blocking) → 이건 wave-3 에서 만든 **fair scheduler**(`server/src/ws/wsSendPolicy.ts`)가 이미 해결했을 수도 있다.

2번이 이미 해결됐다면 바이너리 전환은 **아무것도 개선하지 못하면서 프로토콜 복잡도만 두 배로 늘리는** 변경이 된다.

또 하나 얽혀 있는 것이 **split WebSocket**(제어용 소켓과 출력용 소켓을 물리적으로 분리하는 설계)이다.
`FR-BGSTAB-006`(Split WebSocket handshake and channel isolation, `docs/spec/30.buildergate-stability.srs.md:353`)과 `FR-BGSTAB-007`(Split WebSocket terminal payload routing and failure recovery, 같은 파일 `:419`)이 그 계약이다.

**현재 런타임 상태 (2026-08 기준, 소스 확인):**

- 서버에는 split 소켓 기계장치가 **이미 들어 있다.** `server/src/ws/WsRouter.ts:560` 의 `splitSocketGroups` 가 control 소켓과 output 소켓을 짝지어 들고 있다.
- 그러나 **기본값으로는 켜져 있지 않다.** 전송 모드 설정 `realtime.wsTransportMode` 는 `unified | split-shadow | split` 중 **`unified` 가 기본값**이고(`server/src/schemas/config.schema.ts:56`), `server/config.json5` 에는 `realtime` 블록 자체가 없어 오버라이드도 없다. 브라우저 쪽 소켓 URL 생성도 `frontend/src/utils/webSocketUrl.ts:70` 에서 `wsTransportMode !== 'split'` 을 보고 갈라진다.
- 즉 **split 소켓은 코드로는 존재하지만 실제 서비스 경로에서는 비활성**이다. 그래서 아래 「3단계 — 채택된 경우에만 구현」의 5번이 capability handshake·짝 인증을 "구현한다"고 쓰여 있는 것이다 — 계약이 요구하는 수준까지는 아직 안 만들어져 있다.

이 계약과 실제 런타임 사이의 불일치(drift)는 `REL-BGSTAB-006`(`docs/spec/30.buildergate-stability.srs.md:2498`, Split runtime·test·SRS drift characterization)으로 **"특성화(characterization)"** 되어 있다.
여기서 **특성화란 "차이를 기계가 읽을 수 있는 증거로 기록해 두었다"는 뜻이지 "고쳤다"는 뜻이 아니다.** 해당 요구사항의 AC-5 (요구사항의 Acceptance Criteria 항목. `speckiwi show REL-BGSTAB-006 --json` 의 `acceptanceCriteria[]` 에서 읽는다) 는 오히려 그 **처분(disposition — 이 drift 를 "고침 / 대체 / 미해결" 중 무엇으로 종결할지에 대한 결정)** 을 `unresolved` 로 남기고 split 런타임을 활성화하지 말라고 명시한다.
**이 drift 를 실제로 닫는 것은 #19 가 아니라 #3(Phase 0)의 몫**이고, #19 로 미루면 안 된다는 점이 연구·계획 문서 `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`(이하 "연구 문서") 의 Phase 9 서두(`:666`)에 못 박혀 있다 — *"Phase 0의 기존 FR-BGSTAB-006/007 drift 해결을 이 단계까지 미뤄서는 안 된다."*

## 왜 고쳐야 하나요?

"고친다"의 의미가 이 이슈에서는 두 갈래다.

- **측정하지 않고 방치하면**: 터미널이 느릴 때마다 "바이너리로 바꾸면 빨라지지 않을까?" 하는 추측이 반복해서 살아난다. 근거 없는 대형 프로토콜 변경 제안이 계속 재발한다.
- **측정 없이 바이너리를 도입하면**: control/output 두 개의 인코딩, 버전 협상, 구버전 클라이언트 downgrade, 두 소켓의 짝 인증까지 전부 떠안는다. 이건 영구적인 유지보수 부채다. 그런데 실제 병목이 다른 곳이었다면 얻는 건 0이다.

그래서 이 이슈의 산출물은 **동작하는 바이너리 데이터 플레인**이다. 위 두 문단은 조건부 시절의 서술이며, 이제는 부채를 감수하기로 결정한 상태다 — 감수 대상 부채(두 인코딩, 버전 협상, downgrade, 짝 인증)는 그대로이므로 설계 시 그것을 전제하고 만든다.

> **주니어가 꼭 알아야 할 것**: 이 이슈는 이제 **"안 만들기로 결정함"으로 닫을 수 없다.** `explicitly skipped/not adopted` 종료 경로는 폐기됐다. 그리고 미채택 분기 전용이던 TDD 예외도 함께 소멸했으므로, **모든 동작 변경에 실패 테스트가 선행**한다.

## 배경 지식

### data plane / control plane (데이터 평면 / 제어 평면)

**control plane**은 "무엇을 어떻게 할지"를 주고받는 통로다. 세션 생성, 터미널 크기 변경(resize), 입력 ACK, 에러 알림 같은 **작고 드물지만 늦으면 안 되는** 메시지가 여기 흐른다. **data plane**은 실제 화물, 즉 터미널이 뿜어내는 **출력 바이트 스트림**이 흐르는 통로다. 예: `cat huge.log` 를 치면 키 입력 자체는 control plane, 쏟아지는 로그 100MB는 data plane이다. #19 는 "data plane만 바이너리로 바꾸고 control plane은 JSON 그대로 둔다"는 이야기다.

### HOL blocking (head-of-line blocking, 선두 차단)

한 줄로 선 큐에서 **맨 앞 항목이 막히면 뒤의 모든 항목이 같이 막히는** 현상이다. 마트 계산대 한 줄에 카트 열 개짜리 손님이 서 있으면, 뒤의 껌 하나 든 사람도 똑같이 기다려야 하는 것과 같다. 터미널에서는 `yes` 명령의 출력 10MB가 큐 앞을 채우고 있으면, 그 뒤에 들어온 "Ctrl+C 눌렀음" 제어 메시지가 10MB를 다 보낼 때까지 전달되지 않는다. 그래서 Ctrl+C 가 안 먹는 것처럼 느껴진다. 해결책은 두 가지 계열인데 (a) 줄을 여러 개로 나누는 **fair scheduler**, (b) 물리적으로 소켓을 분리하는 **split**이다. #19 의 gate 2는 "(a)만으로 부족한가?"를 묻는다.

### fair scheduler (공정 전달 스케줄러)

**gate 2 가 판정 대상으로 삼는 바로 그 물건**이다. 한 줄로 세우는 대신 **소켓별·세션별로 lane(차선)을 나눠 두고 돌아가면서 조금씩 보내는** 스케줄러다. 마트 계산대를 여러 개 여는 쪽에 해당한다. 큰 출력이 한 lane 을 채워도 다른 lane 의 제어 메시지는 자기 차례에 나간다.

- **구현**: `server/src/ws/wsSendPolicy.ts` 의 `createFairTerminalDeliveryScheduler`(`:625`).
- **등록부**: `server/src/ws/WsRouter.ts:542-546` 의 `fairDeliverySchedulers` 맵. 소켓 하나당 `connectionEpoch` + scheduler + 유지보수 타이머를 들고 있다.
- **실제 전송 경로**: `WsRouter.ts:5143-5156`. 해당 소켓에 스케줄러가 등록돼 있으면 `scheduler.enqueue(...)` → `drain()` 으로 나간다.

**켜고 끄는 방법은 설정 플래그가 아니라 연결 시 capability 협상이다.** 브라우저가 `terminal-delivery:capability` 메시지를 보내고(`frontend/src/contexts/WebSocketContext.tsx:991`), 서버가 이를 받아들이면 그 소켓에 스케줄러를 등록한다(`WsRouter.ts:1979`). 거절 경로는 **세 갈래**이며, 어느 쪽이든 `accepted: false` 를 돌려주고 그 소켓은 스케줄러 없이 직접 전송 경로(`WsRouter.ts:5159-5167`)로 떨어진다.

1. **클라이언트 철회** — `enabled === false` → `reason: 'client-withdrew'` (`WsRouter.ts:1931-1942`)
2. **hidden dataGap 복구 미지원** — `reason: 'hidden-continuity-unsupported'` (`WsRouter.ts:1943-1953`)
3. **발행된 fair-delivery 정책 아티팩트 거절** — `validatePublishedFairDeliveryCandidateArtifact` 가 런타임 ws-limit 정책을 근거로 등록을 거부한다 (`WsRouter.ts:1957-1968`)

⚠️ 즉 스케줄러 등록은 핸드셰이크 **와** 발행된 fair-delivery 정책 아티팩트 검증을 **둘 다** 통과해야 이뤄진다. 대조군에서 스케줄러가 꺼진 이유가 capability 철회인지 아티팩트 거절인지 반드시 구분해 기록한다.

**측정할 때 이 사실이 중요하다.** gate 2 는 "fair scheduler 가 켜진 상태"와 "꺼진 상태"를 대조해야 하는데, 그 스위치가 config 가 아니라 **핸드셰이크 응답**이므로 벤치마크 하네스에서 클라이언트 쪽 capability 선언을 조작해서 두 조건을 만들어야 한다.

### binary frame vs JSON (바이너리 프레임 대 JSON)

JSON은 사람이 읽을 수 있는 텍스트다. `{"type":"output","data":"hello\n"}` 처럼 생겼다. 장점은 디버깅이 쉽고 필드를 추가해도 구버전이 깨지지 않는다는 것. 단점은 (1) 모든 값을 문자열로 만들었다 다시 파싱해야 하고, (2) 제어문자·비ASCII를 이스케이프하느라 데이터가 커지고, (3) 바이트 길이를 알려면 UTF-8로 다시 인코딩해야 한다는 것이다. **binary frame**은 바이트 배열에 고정 위치로 필드를 박아 넣는다. 예: `[opcode 1바이트][channelId 4바이트][streamEpoch 4바이트][sourceSeq 8바이트][length 4바이트][payload ...]`. 파싱이 offset 계산 몇 번으로 끝나지만, **버전이 다르면 곧바로 해석 불능**이 되므로 버전 협상이 필수가 된다. 그래서 AC에 `versioned binary frame`(버전이 붙은 바이너리 프레임)이라고 쓰여 있다.

### capability handshake (능력 협상)

연결을 맺을 때 양쪽이 **"나는 이런 걸 할 수 있다"** 목록을 먼저 교환하고, 둘 다 지원하는 것 중 가장 좋은 방식을 고르는 절차다. 브라우저가 "binary/v1 지원함"이라고 말하고 서버도 지원하면 바이너리로, 구버전 브라우저가 아무 말 안 하면 JSON으로 간다. 핵심은 **양쪽이 서로 다른 가정을 하고 시작하는 상황을 원천 차단**하는 것이다. AC는 여기서 한 발 더 나가서 "알 수 없는 조합은 조용히 넘어가지 말고 명시적으로 거부하라"고 요구한다.

### downgrade (다운그레이드)

새 방식으로 못 갈 때 **옛 방식으로 안전하게 내려앉는 것**이다. 여기서 중요한 건 "내려앉는 순간의 데이터를 어떻게 처리하느냐"다. AC가 금지하는 나쁜 방법은 두 가지다. (1) 해석 못 하는 프레임을 **silent drop**(조용히 버리기) — 화면에 구멍이 나는데 아무도 모른다. (2) 이미 큐에 쌓인 바이너리 데이터를 JSON인 척 다시 읽기 — 쓰레기 데이터가 화면에 찍힌다. 올바른 방법은 **큐를 버리고 서버에서 fresh snapshot(현재 화면 전체)을 새로 받아오는 것**이다.

### epoch / reconnect epoch (에포크 / 재연결 에포크)

**epoch은 "몇 번째 세대냐"를 나타내는 단조 증가 번호**다. 연결이 끊겼다 붙을 때마다 `connectionEpoch` 가 1 올라간다. 이게 왜 필요하냐면, 끊기기 직전에 날아가던 옛 응답이 재연결 후에 뒤늦게 도착할 수 있기 때문이다. epoch가 다르면 "이건 지난 세대 것"이라고 판단해서 버릴 수 있다. `streamEpoch` 은 같은 개념을 출력 스트림 단위로 적용한 것이다. AC의 "rollback은 binary epoch 종료 → reconnect → JSON fresh snapshot"은 **"세대를 끊고 새 세대에서 처음부터 다시"** 라는 뜻이다.

### SLO (Service Level Objective, 서비스 수준 목표)

"이 정도는 지킨다"고 스스로 정한 **숫자로 된 약속**이다. 예: "키를 눌렀을 때 화면에 글자가 나타나기까지(echo) p95 기준 50ms 이내". p95는 100번 중 95번은 그 안에 든다는 뜻이다. gate 2의 "echo SLO를 만족하지 못해야 한다"는 **이 숫자 약속을 fair scheduler만으로는 못 지킨다는 게 증명돼야 한다**는 의미다.

> ⚠️ 현재 (2026-08) 기준 wave-5용 SRS 요구사항이 아직 하나도 작성되지 않았으므로, **echo SLO의 구체적 숫자는 확정된 값이 없다.** 위의 `50ms` 는 p95 라는 개념을 설명하기 위한 예시일 뿐 계약된 값이 아니다. 측정 전에 SRS로 먼저 확정해야 한다.

### profile (프로파일링)

코드가 CPU 시간을 어디에 쓰는지 실제로 재는 것이다. 추측(`JSON이 느릴 거야`)이 아니라 측정(`JSON.stringify가 전체의 3%`)을 얻는 행위다. gate 1의 "profile에서 유의미한 CPU 비중"이 바로 이 결과를 말한다.

## 무엇을 만들어야 하나요?

이 이슈의 구조는 **"선행 정리 → 구현 → 측정"** 순서다. (개정 전에는 "측정 → 판정 → 조건부 구현" 이었다. 판정 단계가 사라졌으므로 측정은 구현 뒤로 이동해 전후 비교 역할을 맡는다.)

### 0단계 — 시작하기 전 확인

- `docs/spec/00.index.md` 를 읽고 wave-5 target을 확인한다. **현재 wave-5 에 배정된 요구사항은 0건이다** — `speckiwi list --target wave-5 --json` 이 `{"records":[]}` 를 돌려준다. (`docs/spec/00.index.md:37,45` 는 target 이 *등록*돼 있음을 보여줄 뿐 건수를 말하지 않는다.) 즉 런타임 코드를 쓰려면 SRS 요구사항부터 새로 만들어야 한다.
- #3 이 끝났는지 확인한다. split 계약 drift(`REL-BGSTAB-006`)는 #19 가 아니라 #3 에서 닫는다.

### 1단계 — 측정 (코드 변경 없음)

**하네스는 이미 있다. 새로 만들지 않는다.**

| 무엇 | 어디 |
| --- | --- |
| 모드 4종 상수 (`NO_RENDER`, `NO_ANALYZER`, `NO_NETWORK`, `ONE_CLIENT_SLOW`) | `server/src/benchmarks/benchmarkStatistics.ts:1-5` (`BENCHMARK_MODES`) |
| 워크로드 코퍼스 + 실행 진입점 | `server/src/benchmarks/terminalCharacterization.ts` — `createTerminalWorkloadCorpus()`(`:219`), `runTerminalCharacterization({ modes })`(`:295`) |
| 아티팩트 기록 | 같은 파일 `writeTerminalCharacterizationArtifacts(outputDirectory)`(`:349`) |
| CLI 플래그 | 같은 파일 `:1148-1156` — `--write-artifacts <출력디렉터리>` **하나뿐** |
| 공정성 전용 하네스 | `server/src/benchmarks/terminalFairnessCharacterization.ts` (자체 CLI 진입점 `:2398`) |

**모드를 지정하는 방법**은 환경변수가 아니라 **인자**다. `runTerminalCharacterization({ modes: ['NO_NETWORK'] })` 처럼 넘긴다. 목록에 없는 이름을 주면 거절된다. 아무것도 안 주면 4종 전부 돈다.

⚠️ **CLI 에는 모드 플래그가 없다.** npm script 도 없으므로 `server` 디렉터리에서 `npx tsx src/benchmarks/terminalCharacterization.ts --write-artifacts <경로>` 로 직접 실행하는데, 이 CLI 블록(`:1148-1156`)이 받는 인자는 **출력 디렉터리 하나뿐**이고 `--modes` 같은 플래그는 존재하지 않는다. 실제로 `writeTerminalCharacterizationArtifacts(outputDirectory)`(`:349`)는 내부에서 `runTerminalCharacterization()` 을 **인자 없이** 호출하므로 언제나 **4종 모드 × 12종 워크로드 전부**를 돈다. 특정 모드만 재려면 CLI 를 쓰지 말고 `runTerminalCharacterization({ modes: [...] })` 를 호출하는 자기 스크립트를 짜야 한다.

⚠️ 그리고 이 CLI 블록에는 **`main` / `import.meta.url` 가드가 없다.** 최상위에서 `process.argv` 를 그대로 보므로, `--write-artifacts` 가 `process.argv` 에 들어 있는 프로세스에서 이 모듈을 **import 하기만 해도** 벤치마크가 돌아 버린다. 비교 대상인 `terminalFairnessCharacterization.ts` 의 CLI 진입점(`:2398`)은 `process.argv[1] === fileURLToPath(import.meta.url)` 가드를 갖고 있으므로, 두 파일을 같은 수준의 진입점으로 취급하면 안 된다.

**프로파일링은 서버와 브라우저를 반드시 따로 뜬다.** 측정 대상이 두 프로세스에 나뉘어 있기 때문이다 — `JSON.stringify` 는 Node 서버에서, `JSON.parse` 는 브라우저에서 일어난다. 한 프로파일에 섞으면 병목이 어느 쪽인지 귀속시킬 수 없게 된다.

- **서버(Node)**: `node --cpu-prof --cpu-prof-dir <경로>` 로 띄우면 `.cpuprofile` 파일이 떨어진다. Chrome DevTools 의 Performance 패널에 그 파일을 드래그해서 연다.
- **브라우저**: DevTools → Performance 패널에서 직접 녹화한다. `JSON.parse` 와 xterm write 가 어느 프레임에서 얼마나 먹는지 본다.
- 두 프로파일은 **같은 워크로드·같은 시각 구간**에서 뜨되 **파일은 분리해서 보관**한다.

측정 절차:

1. **gate 1 측정**: 출력 폭주 워크로드에서 위 두 프로파일을 뜬다. `JSON.stringify` / `JSON.parse` / UTF-8 재인코딩이 각 프로세스의 전체 CPU에서 차지하는 비중을 숫자로 낸다.
2. **gate 2 측정**: fair scheduler 가 켜진 상태(= capability 협상이 `accepted: true` 로 끝난 연결)에서 control 메시지 지연과 입력 echo 지연을 잰다. 계약된 SLO를 만족하는지 본다. 스케줄러를 끈 대조군은 클라이언트 capability 선언을 철회시켜 만든다. ⚠️ 다만 거절 경로가 셋이므로(배경 지식의 `fair scheduler` 항목 참고), 대조군에서 스케줄러가 꺼진 이유가 **철회인지 아티팩트 거절인지** 서버가 돌려준 `reason` 으로 확인해 기록한다. 확인 없이 재면 "철회 대조군"이라 부르면서 실은 아티팩트 거절 상태를 측정하게 된다.
3. 두 측정 모두 **raw sample을 그대로 보존**한다. 평균값만 남기지 않는다. p50/p95/p99 와 신뢰구간을 함께 남긴다.

### 2단계 — 판정 (폐기)

**이 단계는 삭제됐다.** 판정표와 미채택 분기 3종, `explicitly skipped/not adopted` 종료 경로, 그리고 그 분기 전용이던 TDD 예외 조항이 모두 무효다 (`docs/research/binary-comms/00-decision-record.md` §2.1).

측정 결과가 어떻게 나오든 채택은 확정이다. 측정은 전후 비교와 회귀 감시로 역할이 바뀌었다.

### 3단계 — 구현

1. SRS 요구사항을 먼저 만든다. Phase 0A(기존 split 계약 복원) 경로였다면 `FR-BGSTAB-006/007` 을 확장하고, Phase 0B(계약 교정) 경로였다면 negotiated data-plane용 **신규 요구사항**을 만든다.
2. control은 JSON 그대로 둔다. output/snapshot만 바이너리로 바꾼다.
3. 프레임 포맷에 `channelId`, `streamEpoch`, `sourceSeq`, payload length, opcode 를 넣는다.
4. ACK credit(수신 측이 "이만큼 더 받을 수 있다"고 알리는 흐름 제어 단위)을 **encoded byte 하나로 통일**한다. 문자 수와 바이트 수가 섞이면 한글·이모지에서 계산이 어긋난다.
5. capability handshake, 구/신 클라이언트 downgrade, split 소켓 짝 인증, 각 소켓의 독립 재연결을 구현한다.
6. mixed-version 매트릭스 테스트를 만든다. 해석 못 하는 프레임이 조용히 버려지지 않고 JSON snapshot downgrade 또는 명시적 재연결로 수렴하는지 본다.
7. rollback 경로를 구현한다: binary epoch 종료 → 재연결/능력 재협상 → JSON fresh snapshot.

## 완료 조건 (원문 유지)

### 도입 gate — 폐기됨

원문에는 아래 두 게이트가 AND 조건으로 있었다. **2026-08-16 자로 폐기됐다.**

> ~~1. JSON stringify/parse/UTF-8 재인코딩이 profile에서 유의미한 CPU 비중이어야 한다.~~
> ~~2. fair scheduler만으로 control HOL과 echo SLO를 만족하지 못해야 한다.~~

**폐기 사유**: 두 게이트 모두 임계값이 숫자로 확정된 적이 없다 — gate 1 의 "유의미한 CPU 비중"에는 원문에 숫자가 없고, gate 2 의 echo SLO 도 wave-5 SRS 가 0건이라 확정값이 없다. 판정 가능한 조건이 아니었으므로 실질적으로 무기한 보류 장치였다. 프로젝트 오너 결정으로 무조건 도입으로 전환한다 (`docs/research/binary-comms/00-decision-record.md`).

### Acceptance criteria

- [ ] control은 JSON을 유지하고 output/snapshot만 versioned binary frame을 사용한다.

**해설**: 제어 메시지는 종류가 많고 자주 바뀌므로 유연한 JSON이 유리하고, 출력은 양이 많고 형태가 단순하므로 바이너리가 유리하다. 양쪽을 다 바꾸지 않는 이유가 이것이다.

- [ ] frame에 channelId, streamEpoch, sourceSeq, payload length, opcode가 있으며 ACK credit은 encoded byte 단일 domain이다.

**해설**: `channelId`= 어느 세션/채널 것인지, `streamEpoch`= 몇 번째 스트림 세대인지, `sourceSeq`= 보낸 쪽 기준 몇 번째 조각인지, `opcode`= 이 프레임이 무슨 종류인지. "ACK credit은 encoded byte 단일 domain"은 **흐름 제어 계산에 쓰는 단위를 UTF-8 인코딩된 바이트 하나로만 쓰라**는 뜻이다. 문자 수, 코드포인트 수, 청크 수를 섞어 쓰면 안 된다.

- [ ] capability handshake, old/new downgrade, split pair authentication과 독립 reconnect가 있다.

**해설**: `split pair authentication`은 control 소켓과 output 소켓이 **같은 클라이언트의 짝**임을 서버가 확인하는 절차다. 이게 없으면 남의 output 소켓이 내 control 소켓에 붙는 사고가 가능하다. `독립 reconnect`는 둘 중 하나만 끊겨도 나머지를 살린 채 복구할 수 있어야 한다는 뜻이다.

- [ ] unsupported/mixed-version frame은 silent drop하지 않고 JSON snapshot downgrade 또는 명시적 reconnect로 수렴한다.

**해설**: 화면에 소리 없이 구멍이 나는 게 최악이다. 못 읽겠으면 **읽을 수 있는 상태로 명시적으로 복구**하라는 것.

- [ ] rollback은 binary epoch 종료 → reconnect/capability renegotiation → JSON fresh snapshot이며 binary queue를 JSON으로 재해석하지 않는다.

**해설**: 되돌릴 때 이미 쌓인 바이너리 데이터를 재활용하려는 유혹을 명시적으로 금지한다. 세대를 끊고 서버가 준 현재 화면으로 처음부터 다시 그린다.

### 공통 완료 조건

> - Parent: #2
> - Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
> - 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하며 missing/draft/deprecated 계약에서는 blocked다.
> - behavior change는 failing regression test부터 TDD로 진행한다. evidence-only skip/documentation 분기는 적용 가능한 SpecKiwi·benchmark·review evidence로 검증한다.
> - 관련 test/typecheck/build와 적용 가능한 `https://localhost:2222` 검증을 수행하고 `node.exe`와 TCP 2001/2002 process를 중단하지 않는다.
> - rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
> - Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설**:

`SpecKiwi` 는 이 저장소의 요구사항(SRS) 관리 도구다. 요구사항 원본은 `docs/spec/` 아래 마크다운으로 들어 있고, `speckiwi` CLI 와 동명의 MCP 도구가 그것을 읽고 안전하게 고친다.

`Stability` 는 **요구사항이 얼마나 확정됐는지**를 나타내는 값이며 `draft` → `evolving` → `stable` 순으로 올라간다(그 밖에 `frozen`, `deprecated` 가 있다). **`draft` 요구사항을 보고 짠 코드는 요구사항이 움직이면 버려진다.** 그래서 `missing`(요구사항 없음) / `draft` / `deprecated` 는 전부 blocked 다.

**요구사항 ID 와 `Stability` 를 확인하는 절차:**

1. `docs/spec/00.index.md` 를 연다. §2 `SRS Documents` 표가 scope 별 문서와 접두사를 알려 준다 — 예를 들어 접두사 `BGSTAB` 는 `docs/spec/30.buildergate-stability.srs.md` 에 산다. §3 `Target Map` 은 target(`wave-5` 등) 목록이다.
2. 해당 scope 문서에서 `### <요구사항 ID> — <제목>` 형태의 제목을 찾는다. 바로 아래 메타데이터 표에 `| Stability | evolving |` 같은 행이 있다. 그 값이 그 요구사항의 현재 `Stability` 다.
3. 도구로 확인하는 쪽이 빠르고 정확하다: `speckiwi list --json` 으로 요구사항을 열거하고, `speckiwi show <ID> --json` 의 `metadata.Stability` 를 읽고, `speckiwi active-target --json` 으로 현재 활성 target 을 본다. MCP 가 붙어 있으면 `list_requirements` / `get_requirement` / `get_active_target` 이 같은 일을 한다. ⚠️ **`--target wave-5` 로 좁히지 말 것** — wave-5 에는 0건이라 무조건 빈 결과가 나오고, 그것을 `missing` 으로 오독하면 이미 존재하는 다른 target 의 계약을 못 보고 blocked 판정을 내리게 된다. ⚠️ `speckiwi list` / `speckiwi show` 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 함께 출력될 수 있다. 명령 실패가 아니며 요청한 레코드는 정상적으로 반환된다.
4. **찾는 요구사항이 아예 없거나, 있어도 `Stability` 가 `stable` 이 아니면 그 지점에서 멈춘다.** 요구사항을 먼저 만들거나 승급시키는 것이 다음 작업이지, 구현을 시작하는 것이 아니다.

`No findings` 는 리뷰어가 지적사항 0건을 판정했다는 뜻이며, 지적을 고친 뒤 **다시 리뷰를 받아** 0건이 나와야 한다.

## 의존성과 순서

**먼저 끝나야 하는 것**

- **#3 (Phase 0)** — split 계약과 실제 런타임의 불일치를 먼저 닫아야 한다. 이걸 #19 로 미루는 것은 명시적으로 금지되어 있다.
- **#13** — per-client/per-session fair scheduler와 ACK/credit ledger. **gate 2 를 측정하려면 fair scheduler가 이미 동작하고 있어야 한다.** "fair scheduler만으로 부족한가"를 물으려면 fair scheduler가 있어야 하기 때문이다.
- **#14** — hidden 탭의 `dataGap` 처리와 reveal 복구.
- **Phase 0 측정 gate와, 도입할 경우의 신규 SRS 승인.**

**이 이슈가 끝나야 시작할 수 있는 것**

- **#20** — binary/socket consumer 항목을 채운다. (`skipped` 분기와 skip 증거 링크 조항은 폐기됐다 — 채택이 확정이므로.)
- **#21** — 선행 조건이던 "`#19 adopted 완료` 또는 `evidence-backed explicitly skipped`" 는 **`adopted` 로 확정**됐다. 더 이상 #19 의 결론을 기다리지 않는다.

## 참고

- 원본 이슈: `Snoworca/BuilderGate#19` (`gh issue view 19`)
- 연구 문서 Phase 9: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:664-684`
- 연구 문서 Phase 0(측정 harness·필수 지표·종료 조건): 같은 파일 `:419-452`
- wave-master 계획 wave-5 범위/gate: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:83-94`
- wave-5 완료 처리 브레이크: 같은 파일 `:24`
- 관련 SRS: `docs/spec/30.buildergate-stability.srs.md:353` (`FR-BGSTAB-006`), `:419` (`FR-BGSTAB-007`), `:2498` (`REL-BGSTAB-006` Split runtime·test·SRS drift characterization), `:2657` (`PERF-BGSTAB-008` Benchmark modes and raw evidence contract)
- wave-5 target 등록 위치: `docs/spec/00.index.md:37,45` (Target Map 행과 목표 헤딩. 요구사항 0건이라는 사실 자체는 `speckiwi list --target wave-5 --json` 결과에서 온다)
- 현재 JSON/UTF-8 재인코딩 지점 예시: `frontend/src/utils/terminalOutputHotPath.ts:12`, `frontend/src/components/Terminal/TerminalView.tsx:589`
- 서버 전송 정책·fair scheduler: `server/src/ws/wsSendPolicy.ts`
