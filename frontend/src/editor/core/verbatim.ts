/**
 * **원문을 그대로 보여 주는 자리** — 코드 펜스와 코드 스팬.
 *
 * 태그(`FR-EDITOR-007` AC-10)와 수식(AC-8)이 같은 규칙을 쓴다. 두 곳에
 * 따로 적으면 한쪽만 규칙이 바뀌고, 그러면 같은 코드블록에서 태그는
 * 안 잡히는데 수식은 잡히는 상태가 된다.
 *
 * 구문 트리를 쓰지 않는 이유는 이 판정이 **에디터 없이도** 서야 하기
 * 때문이다 — 트리는 언어 확장이 붙은 상태에서만 채워지는데, 그 상태를
 * 요구하면 규칙을 확인하려고 에디터를 띄워야 한다.
 */

/** 펜스를 여닫는 줄인가. 들여쓴 펜스도 잡는다. */
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * 코드 펜스가 덮은 줄 번호들.
 *
 * **닫히지 않은 펜스는 그 뒤를 삼키지 않는다** — 삼키면 펜스를 잘못 연
 * 문서의 태그·수식이 전부 사라지고, 그 사실은 문서를 열 때까지 드러나지
 * 않는다.
 */
export function fencedLines(lines: readonly string[]): ReadonlySet<number> {
  const inside = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    if (!FENCE.test(lines[i]!)) continue;

    const marker = lines[i]!.trimStart().slice(0, 3);
    const closing = lines.findIndex(
      (line, at) => at > i && FENCE.test(line) && line.trimStart().startsWith(marker),
    );
    if (closing === -1) continue;

    for (let at = i; at <= closing; at += 1) inside.add(at);
    i = closing;
  }

  return inside;
}

/** 그 문서에서 펜스가 덮은 **문자 오프셋** 구간들. */
export function fencedRanges(text: string): Array<[number, number]> {
  const lines = text.split('\n');
  const rows = fencedLines(lines);
  const ranges: Array<[number, number]> = [];

  let at = 0;
  for (const [row, line] of lines.entries()) {
    if (rows.has(row)) ranges.push([at, at + line.length + 1]);
    at += line.length + 1;
  }

  return ranges;
}

/** 코드 스팬(백틱) 안인가 — 그 줄 안에서 앞선 백틱 수가 홀수면 안이다. */
export function insideCodeSpan(line: string, at: number): boolean {
  let ticks = 0;
  for (let i = 0; i < at; i += 1) if (line[i] === '`') ticks += 1;
  return ticks % 2 === 1;
}

/** 그 문서의 `at` 오프셋이 코드 스팬 안인가. */
export function insideCodeSpanAt(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = text.indexOf('\n', at);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  return insideCodeSpan(line, at - lineStart);
}

/**
 * 원문 자리를 **공백으로 가린 사본**.
 *
 * 길이와 오프셋을 그대로 두고 글자만 지운다 — 찾는 쪽이 자리를 그대로
 * 쓸 수 있어야 하기 때문이다.
 *
 * 「찾은 뒤 걸러 내기」가 아니라 「가리고 찾기」인 이유는 정규식이 자리를
 * **소비**하기 때문이다. 펜스 안의 `$$` 를 찾은 뒤 버리면 그 매치가 이미
 * 뒤쪽을 먹어 치워, 바로 다음에 오는 진짜 수식이 통째로 사라진다.
 */
export function maskVerbatim(text: string): string {
  // `[...text]` 로 쪼개면 **코드 포인트** 단위가 되는데 여기 써 넣는
  // 인덱스는 전부 **코드 유닛** 오프셋이다. 이모지가 하나만 있어도 그
  // 뒤의 가리기가 통째로 밀려, 펜스 밖의 본문이 지워지거나 수식이 엉뚱한
  // 원문을 렌더한다. `split('')` 은 코드 유닛으로 쪼갠다.
  const masked = text.split('');

  for (const [from, to] of fencedRanges(text)) {
    for (let at = from; at < to && at < masked.length; at += 1) {
      if (masked[at] !== '\n') masked[at] = ' ';
    }
  }

  // 코드 스팬은 줄 안에서만 성립하므로 줄 단위로 훑는다.
  let at = 0;
  for (const line of text.split('\n')) {
    let open = -1;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '`') continue;
      if (open === -1) open = i;
      else {
        for (let k = open; k <= i; k += 1) masked[at + k] = ' ';
        open = -1;
      }
    }
    at += line.length + 1;
  }

  return masked.join('');
}
