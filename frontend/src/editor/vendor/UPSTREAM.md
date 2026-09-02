# Vendored: atomic-editor

이 디렉터리는 **외부 오픈소스의 사본**입니다. 우리 코드가 아닙니다.

| 항목 | 값 |
|---|---|
| 프로젝트 | [kenforthewin/atomic-editor](https://github.com/kenforthewin/atomic-editor) |
| 저작권 | Copyright (c) 2026 Kenny Bergquist |
| 라이선스 | **MIT** — 전문은 `atomic-editor/LICENSE` |
| 도입 커밋 | `b6ed65f01bde4510031bc7a495520bc1a7688c66` (v0.6.2, 2026-07-11) |
| 도입일 | 2026-08-12 |
| npm 대응 | `@atomic-editor/editor@0.6.2` |

채택 근거와 코드 분석은 [`docs/research/editor/`](../../../../docs/research/editor/00.index.md) 참조.

---

## 라이선스 의무

MIT 는 copyleft 가 아닙니다. 수정·비공개 배포가 허용됩니다.
의무는 하나 — **저작권 고지와 라이선스 전문을 함께 배포**하는 것입니다.

→ `atomic-editor/LICENSE` 를 **삭제하거나 이동하지 마십시오.**

---

## 개조 원칙

upstream 이 활발히 개발 중이므로(2026-04 시작, 8월까지 73커밋),
버그픽스를 받아올 수 있도록 **이 디렉터리의 수정을 최소화**합니다.

| 계층 | 방식 | 이 디렉터리 수정 |
|---|---|---|
| **A** | `extensions` prop 으로 CM6 확장 주입 | 없음 |
| **B** | `src/react/` 에 우리 래퍼 자체 구현 | 없음 |
| **C** | 코어 동작 자체를 바꿔야 하는 경우 | **불가피** |

계층 C 작업은 **반드시 단독 커밋**으로 분리하십시오. upstream rebase 시 우리 패치만 골라내기 위함입니다.

---

## 적용한 패치

| # | 커밋 | 대상 파일 | 사유 |
|---|---|---|---|
| — | — | — | (아직 없음) |

> 계층 C 패치를 넣을 때마다 이 표에 한 줄 추가하십시오.

---

## upstream 재동기화 절차

```bash
git clone https://github.com/kenforthewin/atomic-editor.git /tmp/ae-new
diff -ru packages/editor/src/vendor/atomic-editor /tmp/ae-new/src
```

위 "적용한 패치" 표의 항목만 재적용 대상입니다. 표에 없는 차이는 우리가 만든 것이 아니어야 합니다.
