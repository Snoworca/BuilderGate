# Phase 1 Verification

## 목적

production static serving contract가 reserved route를 깨지 않고 동작하는지 검증한다.

## 확인 항목

- [ ] production branch에서 `publicDir` absolute path가 계산된다
- [ ] `GET /`가 `index.html`을 반환한다
- [ ] `/assets/*`와 `/logo.svg`가 static으로 제공된다
- [ ] `/api`, `/health`, `/ws`가 static fallback에 가려지지 않는다
- [ ] missing asset이 HTML fallback으로 오염되지 않는다

## 증거

- curl/브라우저 응답 캡처
- route ordering notes
- code reference

