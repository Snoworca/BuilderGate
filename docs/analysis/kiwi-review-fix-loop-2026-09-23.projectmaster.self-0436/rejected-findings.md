# 거절한 finding 4건 — kiwi-review-fix-loop 2026-09-23.projectmaster.self-0436

FND-010 [already_intended] AC-9 가 index.css 만 확인하고 main.tsx 는 안 본다
  리뷰어 말이 맞다. 다만 main.tsx:5 가 현재 존재하고, 더 중요하게는 Windows 에서 실제
  vite build 를 돌려 번들 CSS 에 토큰·paper·compact 블록이 들어가고 @import 가 0건
  남는 것을 직접 확인했다(build 타입 증거로 AC-9 에 등재). 단위 가드가 한 칸 짧은 것은
  사실이나 그 칸을 빌드 증거가 메웠다. 가드 자체를 늘리는 것은 값이 있고 후속으로 남긴다.

FND-012 [out_of_scope] block() 이 선택자를 부분문자열로 찾고 첫 중괄호로 자른다
  리뷰어와 내 측정이 일치한다(중첩 블록이면 안쪽 값을 읽고, :root 가 둘이면 첫 번째만
  읽는다). 그러나 오늘의 tokens.css 에는 중첩도 중복 선택자도 없어 전부 잠재다.
  FND-009 를 고치면서 값 파싱이 들어가므로 그때 함께 손보는 것이 자연스럽다.
  단독 수정 대상으로 잡지 않는다.

FND-013 [out_of_scope] AC-4·AC-5 검사가 tokens.css 한 파일에만 걸려 있다
  DR-4/DR-5 의 check 는 '새 파일' 복수형이 맞다. 그러나 오늘 새 CSS 는 tokens.css
  하나뿐이라 결과가 같고, 이 구멍을 덮을 자리는 AC-10('새 컴포넌트 CSS 에 hex 리터럴
  금지')인데 그것은 검사 대상 집합이 비어 공허하다는 이유로 이번에 의도적으로 미뤘다.
  AC-10 을 닫을 때 세 검사를 '새 CSS 파일 집합' 인자 형태로 함께 확장한다.

FND-015 [out_of_scope] fileNameCollision.test.ts 를 돌리는 npm script 가 없다
  사실이고 CLAUDE.md 가 '테스트 표면이 여러 곳으로 흩어져 있다' 고 경고하는 그 목록이
  한 줄 길어진 것도 맞다. 그러나 이것은 저장소의 기존 구조이고 이 커밋이 만든 문제가
  아니다 — 리뷰어 자신도 그렇게 적었다. 테스트 실행 경로 정비는 별건이다.
