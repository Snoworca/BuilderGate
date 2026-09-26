# 이슈 #81 — 첫 시도 실패의 계측과 측정

이 레인은 `#5` 레인의 관측을 반박하지 않는다. 그 레인이 *가설로* 남긴 것을 **계측을 고쳐서 측정 가능하게** 만들고, 이 플랫폼에서 재현 가능한 표면에서 같은 형태를 하나 찾아 원인을 특정한다.

## 1. 원래 재현은 이 레인에서 불가능하다

`#81` 이 8회 중 5회를 관측한 스펙은 `wave2-screen-repair-resync.spec.ts` 이고, 그 파일 머리에 `requiresWindowsShell(test, "creates a session with shell: 'powershell'")` 가 있다(`#85`). **Linux/WSL2 에서는 skip 된다.** 따라서 원래 서명(RED-contract 3 / precondition 2)의 재측정은 여기서 할 수 없다. 그 사실을 먼저 적는다.

## 2. 시드 도구의 결함 — 이슈의 지적이 맞았고, 읽어 보면 더 나쁘다

`#5` 레인의 `issue5-seed-terminal.mjs`:

```js
if (await add.count()) { await add.first().click(); }
else { console.log('terminal already present'); }
await page.waitForSelector('.xterm-screen:visible', { timeout: 20000 });
await page.waitForTimeout(2000);
```

1. **탭 생성을 확인하지 않는다.** `.xterm-screen:visible` 은 **이미 있던 터미널**이 만족시킨다. 새로 만든 것이 어디에도 없어도 성공으로 보고된다.
2. **"+ Add Terminal" 만 안다.** 그 컨트롤은 빈 상태에서만 나오고, 터미널이 이미 있으면 탭바의 `+`(title="Add Terminal")가 생성 창구다. 실측: 터미널이 하나 있는 상태에서 옛 도구는 `terminal already present` 를 찍고 **아무것도 만들지 않은 채 exit 0** 한다.
3. **나이를 기록하지 않는다.** 이슈의 가설이 바로 그 변수에 관한 것인데.
4. **준비 판정이 고정 2초 sleep 이다.**

### 새 시드 도구의 실측

`tools/seed-terminal.mjs` — 생성 전후 개수를 세고 정확히 1 증가를 요구하며, **새 터미널을 인덱스로 지목해** 가시성을 기다리고, 시계를 JSON 으로 낸다.

```json
{"terminalsBefore":1,"action":"clicked-add-terminal","terminalsAfter":2,
 "newTerminalVisibleAfterMs":3698,"createdAt":"2026-09-18T23:05:31.433Z"}
```

**새 터미널이 보이기까지 3.7초.** 옛 도구의 2초 sleep 은 그보다 짧고, 게다가 그 sleep 은 *이미 있던* 터미널의 가시성 뒤에 붙어 있었다. 즉 스펙은 **준비되지 않은 터미널 위에서 시작할 수 있었다.**

## 3. 이 플랫폼에서 재현된 같은 형태

`markdown-editor-persistence.spec.ts` 를 `--retries=0` 으로 4회 돌려 4회차에서 2건 실패:

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
  waiting for locator('.workspace-tabbar [role="tab"]')
            .filter({ hasText: 'e2e-mde-persist-ac4-host' }).first()
```

이 스펙은 탭을 **API 로** 만들고(`addTabAt`), 탭바가 그것을 아는 것은 비동기다. 그런데 `selectTab` 은 곧바로 클릭해서 **클릭 자신의 10초 auto-wait 가 예산의 전부**였다. 그 경주에서 지면 "클릭이 타임아웃됐다" 는 메시지만 남는다 — 어느 탭이 왜 없었는지는 말하지 않는다. **"첫 시도 실패, 재시도 통과"** 의 그 형태다.

### 고친 방식

`selectTab` 이 탭의 존재를 먼저 기다린다. 고정 sleep 이 아니라 **관측 가능한 전이**이고, 진짜로 탭이 안 오면 어느 탭이 렌더되지 않았는지를 말한다.

### 반복 실행 (1회 통과로 판정하지 않음)

| | retries=0 |
|---|---|
| 수정 전 | 4회 중 **1회 실패**(2건) |
| 수정 후 | **6회 연속 통과** |

## 4. 가설 판정

> "갓 생성된 세션" 과 "첫 시도" 중 무엇이 변수인가

이 레인에서 찾은 실패는 **세션 나이가 아니라 생성 후 관측 가능성**이 변수였다 — API 로 만든 것이 UI 에 도달하기 전에 UI 를 누른다. 나이는 그 창을 넓히는 요인일 뿐 원인이 아니다.

원래 레인의 서명이 같은 원인인지는 **단정하지 않는다.** 그 스펙이 `#85` 로 막혀 있어 재측정이 불가능하고, 여기서 찾은 것은 같은 *계열*이지 같은 *사건*이 아니다. 계측은 이제 갖춰져 있으므로, win32 레인에서 그 스펙을 돌릴 수 있게 되면 같은 방법으로 판정할 수 있다.

## 5. 남긴 것

- `frontend/tests/e2e/helpers.ts` 에 `waitForTerminalCount` · `waitForFreshTerminal` 추가. 기존 `waitForTerminal` 의 72개 호출부는 건드리지 않았다 — 그 함수는 "터미널이 하나인 페이지" 에서는 옳은 질문이다. 방금 만든 터미널을 기다리는 호출자는 **다른 질문**을 하고 있고, 그것을 표현할 수단이 없었다.
- 이 레인이 만든 터미널 1개는 작업 후 삭제했다(생성한 것만 소유하고, 그것만 지운다).
