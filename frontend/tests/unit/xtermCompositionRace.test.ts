// @req FR-BGSTAB-039
// xterm.js 6.0.0 sends a committed composition from a setTimeout(0) and tracks the pending
// send in one boolean (xtermjs/xterm.js#6089). When the page delays its timers -- many
// terminals each arming write and snapshot timers -- that timeout runs after the next
// compositionend and a syllable goes out twice or not at all. These tests drive the real
// xterm bundle in Chromium with CDP composition events, the way a Korean IME commits
// syllables, and flood the timer queue the way a busy BuilderGate page does.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';

const FRONTEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const XTERM_LIB = `${FRONTEND_ROOT}node_modules/@xterm/xterm/lib/xterm.js`;
const XTERM_CSS = `${FRONTEND_ROOT}node_modules/@xterm/xterm/css/xterm.css`;

// The jamo steps a Korean IME shows for each syllable of 한글입력빠르게, then the commit.
const SYLLABLES: readonly (readonly string[])[] = [
  ['ㅎ', '하', '한'], ['ㄱ', '그', '글'], ['ㅇ', '이', '입'], ['ㄹ', '려', '력'],
  ['ㅃ', '빠'], ['ㄹ', '르'], ['ㄱ', '게'],
];
const WORD = '한글입력빠르게';
const REPEAT = 3;
const STEP_MS = 12;

let browser: Browser;
let page: Page;
let cdp: CDPSession;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resetData(): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __data: string[] }).__data = []; });
}

async function readData(): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __data: string[] }).__data.slice());
}

/** Waits until onData has been quiet for a while, so late timers have run. */
async function settledData(): Promise<string[]> {
  let last = -1;
  for (let i = 0; i < 100; i += 1) {
    const data = await readData();
    if (data.length === last) return data;
    last = data.length;
    await sleep(150);
  }
  return readData();
}

/**
 * Holds every setTimeout(0) while input events keep arriving, the way a busy BuilderGate page
 * (many terminals arming write, snapshot and class timers) delays xterm's commit timer.
 *
 * Timers are released one syllable late: after syllable k is committed, every timer armed
 * before syllable k-1's compositionend runs. That gives the order that breaks xterm 6.0.0 --
 * A ends, B ends, A's timer, C ends, B's timer -- on every syllable rather than by chance.
 * A uniform delay is not enough: when every timer is late by the same amount the timers run
 * in order and xterm only merges syllables, which is still correct text.
 */
async function setTimerFlood(on: boolean): Promise<void> {
  await page.evaluate((enable) => {
    type Held = { seq: number; run: () => void };
    const w = window as unknown as {
      __realSetTimeout?: typeof setTimeout;
      __held: Held[]; __seq: number; __endMarks: number[];
      __releaseBefore: (seq: number) => void;
    };
    if (!w.__realSetTimeout) {
      w.__realSetTimeout = window.setTimeout.bind(window);
      w.__held = []; w.__seq = 0; w.__endMarks = [];
      // Capture phase on the document runs before xterm's own compositionend listener on the
      // textarea, so the mark separates timers armed before this commit from those it arms.
      document.addEventListener('compositionend', () => { w.__endMarks.push(w.__seq); }, true);
      w.__releaseBefore = (seq: number) => {
        const due = w.__held.filter((h) => h.seq < seq);
        w.__held = w.__held.filter((h) => h.seq >= seq);
        for (const h of due) h.run();
      };
    }
    const real = w.__realSetTimeout;
    if (!enable) {
      window.setTimeout = real;
      w.__releaseBefore(Number.POSITIVE_INFINITY);
      return;
    }
    w.__endMarks = [];
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if ((ms ?? 0) !== 0 || typeof handler !== 'function') return real(handler, ms, ...args);
      const seq = w.__seq++;
      w.__held.push({ seq, run: () => (handler as (...a: unknown[]) => void)(...args) });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  }, on);
}

/**
 * Called right after a syllable is committed: runs the held timers armed before that
 * syllable's compositionend, so the previous syllable's commit timer runs only now.
 */
async function releaseLateTimers(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __endMarks?: number[]; __releaseBefore?: (seq: number) => void; __realSetTimeout?: unknown };
    if (!w.__releaseBefore || !w.__endMarks || window.setTimeout === w.__realSetTimeout) return;
    const marks = w.__endMarks;
    if (marks.length >= 1) w.__releaseBefore(marks[marks.length - 1]);
  });
}

async function composeSyllable(steps: readonly string[]): Promise<void> {
  for (const step of steps) {
    await cdp.send('Input.imeSetComposition', { text: step, selectionStart: 1, selectionEnd: 1 });
    await sleep(STEP_MS);
  }
}

async function typeWord(times: number): Promise<void> {
  for (let r = 0; r < times; r += 1) {
    for (const steps of SYLLABLES) {
      await composeSyllable(steps);
      await cdp.send('Input.insertText', { text: steps[steps.length - 1] });
      await releaseLateTimers();
      await sleep(STEP_MS);
    }
  }
}

describe('FR-BGSTAB-039 xterm composition commits under delayed timers', () => {
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="t" style="width:900px;height:500px"></div></body></html>');
    await page.addStyleTag({ content: readFileSync(XTERM_CSS, 'utf8') });
    await page.addScriptTag({ content: readFileSync(XTERM_LIB, 'utf8') });
    await page.evaluate(() => {
      const w = window as unknown as { Terminal: new (o: object) => { open(e: Element): void; focus(): void; onData(cb: (d: string) => void): void }; __data: string[] };
      const term = new w.Terminal({ cols: 100, rows: 20 });
      term.open(document.getElementById('t')!);
      w.__data = [];
      term.onData((d) => w.__data.push(d));
      term.focus();
    });
    cdp = await page.context().newCDPSession(page);
  });

  after(async () => {
    await browser?.close();
  });

  test('AC-1: every syllable is sent once and in order while timers are delayed', async () => {
    const expected = WORD.repeat(REPEAT);
    const failures: string[][] = [];
    for (let run = 0; run < 6; run += 1) {
      await resetData();
      await setTimerFlood(true);
      await typeWord(REPEAT);
      await setTimerFlood(false);
      const data = await settledData();
      if (data.join('') !== expected) failures.push(data);
    }
    assert.deepEqual(failures, [], `runs that sent the wrong text: ${JSON.stringify(failures)}`);
  });

  test('AC-3: without timer load one onData carries each committed syllable', async () => {
    await resetData();
    await typeWord(1);
    const data = await settledData();
    assert.deepEqual(data, [...WORD]);
  });

  test('AC-4: a digit typed right after a composition is sent once, after the syllable', async () => {
    for (const load of [false, true]) {
      await resetData();
      await setTimerFlood(load);
      await composeSyllable(SYLLABLES[0]);
      await page.keyboard.press('Digit1');
      await setTimerFlood(false);
      const data = await settledData();
      // A CDP key press does not end Chrome's composition the way an IME commit does; clear
      // it so the next run starts a new composition instead of rewriting this one.
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await sleep(50);
      assert.equal(data.join(''), '한1', `load=${load} sent ${JSON.stringify(data)}`);
    }
  });

  // The keys a Windows Korean IME produces, replayed as DOM events with every setTimeout(0)
  // held until the scenario ends: keyCode 229 keydowns, compositions, and characters the IME
  // inserts without composing (digits, punctuation and Space typed in Hangul mode).
  const HELD_TIMER_SCENARIOS: ReadonlyArray<{ name: string; expected: string; script: string }> = [
    { name: '229 digits 1 2', expected: '12', script: "kd(229,'1');ins('1');kd(229,'2');ins('2');" },
    { name: '229 digits 1 2 3', expected: '123', script: "kd(229,'1');ins('1');kd(229,'2');ins('2');kd(229,'3');ins('3');" },
    { name: '229 digit then Hangul', expected: '1한', script: "kd(229,'1');ins('1');compose(['ㅎ','하','한']);" },
    { name: 'Hangul then 229 digit', expected: '한1', script: "compose(['ㅎ','하','한']);kd(229,'1');ins('1');" },
    { name: 'Hangul, flush, two 229 digits', expected: '한12', script: "compose(['ㅎ','하','한']);flush();kd(229,'1');ins('1');kd(229,'2');ins('2');" },
    { name: 'Hangul, 229 Space, Hangul', expected: '한 글', script: "compose(['ㅎ','하','한']);kd(229,' ');ins(' ');compose(['ㄱ','그','글']);" },
    { name: 'three Hangul syllables', expected: '한글입', script: "compose(['ㅎ','하','한']);compose(['ㄱ','그','글']);compose(['ㅇ','이','입']);" },
    { name: 'Hangul, Enter, Hangul', expected: '한\r글', script: "compose(['ㅎ','하','한']);kd(13,'Enter');compose(['ㄱ','그','글']);" },
    { name: 'Hangul then Ctrl+C', expected: '한\x03', script: "compose(['ㅎ','하','한']);kd(67,'c',{ctrlKey:true});" },
    { name: 'Hangul then Backspace', expected: '한\x7f', script: "compose(['ㅎ','하','한']);kd(8,'Backspace');" },
    { name: 'cancelled composition', expected: '', script: "kd(229,'Process');base=0;cs();cu('ㅎ');ta.value='';ce('');" },
    { name: 'two Japanese commits', expected: '日本語', script: "compose(['に','にほ','日本'],'日本');compose(['ご','語'],'語');" },
    { name: '229 digit, Hangul, 229 digit, each flushed', expected: '1한2', script: "kd(229,'1');ins('1');flush();compose(['ㅎ','하','한']);flush();kd(229,'2');ins('2');flush();" },
    // Enter empties the textarea; a timer armed before it must not read that as a deletion.
    { name: '229 digit then Enter', expected: '3\r', script: "kd(229,'3');ins('3');kd(13,'Enter');" },
    // A digit typed after Enter while an older timer is pending has no timer of its own.
    // #261: paste and blur empty the textarea before the commit timer reads it.
    { name: 'Hangul then paste event', expected: '한abc', script: "compose(['ㅎ','하','한']);pasteEvent('abc');" },
    { name: 'Hangul then term.paste', expected: '한xy', script: "compose(['ㅎ','하','한']);term.paste('xy');" },
    { name: 'Hangul then blur', expected: '한', script: "compose(['ㅎ','하','한']);ta.dispatchEvent(new FocusEvent('blur'));" },
    { name: 'Hangul, blur, Hangul', expected: '한글', script: "compose(['ㅎ','하','한']);ta.dispatchEvent(new FocusEvent('blur'));compose(['ㄱ','그','글']);" },
    { name: 'digit after Enter with an older timer pending', expected: '한한3\r3입\r', script: "compose(['ㅎ','하','한']);compose(['ㅎ','하','한']);flush();kd(229,'3');ins('3');kd(13,'Enter');kd(229,'3');ins('3');flushOne();compose(['ㅇ','이','입']);kd(13,'Enter');" },
  ];

  test('AC-1, AC-4: 229 characters and compositions are sent once and in order whatever the timer order', async () => {
    const failures: string[] = [];
    for (const scenario of HELD_TIMER_SCENARIOS) {
      const scenarioPage = await browser.newPage();
      try {
        await scenarioPage.setContent('<div id="t" style="width:900px;height:400px"></div>');
        await scenarioPage.addScriptTag({ content: readFileSync(XTERM_LIB, 'utf8') });
        const data = await scenarioPage.evaluate((script) => {
          const w = window as unknown as Record<string, unknown> & { Terminal: new (o: object) => {
            open(e: Element): void; textarea: HTMLTextAreaElement; onData(cb: (d: string) => void): void; paste(d: string): void;
          } };
          const real = window.setTimeout.bind(window);
          let held: Array<() => void> = [];
          window.setTimeout = ((fn: TimerHandler, ms?: number, ...a: unknown[]) => {
            if ((ms ?? 0) !== 0 || typeof fn !== 'function') return real(fn, ms, ...a);
            held.push(() => (fn as (...x: unknown[]) => void)(...a));
            return 0;
          }) as typeof setTimeout;
          const term = new w.Terminal({ cols: 80, rows: 10 });
          term.open(document.getElementById('t')!);
          const ta = term.textarea;
          const out: string[] = [];
          term.onData((d) => out.push(d));
          const flush = () => { while (held.length) { const due = held; held = []; due.forEach((f) => f()); } };
          const flushOne = () => { held.shift()?.(); };
          const kd = (keyCode: number, key: string, extra: KeyboardEventInit = {}) => {
            const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
            Object.defineProperty(e, 'keyCode', { get: () => keyCode });
            Object.defineProperty(e, 'which', { get: () => keyCode });
            ta.dispatchEvent(e);
          };
          const ins = (text: string) => {
            ta.value += text;
            ta.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', composed: true, bubbles: true }));
          };
          let base = 0;
          const cs = () => ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
          const cu = (text: string) => { ta.value = ta.value.slice(0, base) + text; ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: text })); };
          const ce = (text: string) => ta.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
          const compose = (steps: string[], commit = steps[steps.length - 1]) => {
            kd(229, 'Process'); base = ta.value.length; cs();
            for (const step of steps) cu(step);
            ta.value = ta.value.slice(0, base) + commit; ce(commit);
          };
          const pasteEvent = (text: string) => {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          };
          // The scenario scripts use these names.
          Object.assign(w, { kd, ins, cs, cu, ce, compose, flush, flushOne, pasteEvent, ta, term });
          Object.defineProperty(w, 'base', { get: () => base, set: (v: number) => { base = v; }, configurable: true });
          new Function(script)();
          flush();
          return out;
        }, scenario.script);
        if (data.join('') !== scenario.expected) failures.push(`${scenario.name}: ${JSON.stringify(data)}`);
      } finally {
        await scenarioPage.close();
      }
    }
    assert.deepEqual(failures, []);
  });

  test('AC-5: the xterm version is pinned and installing dependencies patches both bundles', async () => {
    const { PATCHED_XTERM_VERSION, PATCH_MARKER } = await import('../../patches/xterm-composition.mjs');
    const pkg = JSON.parse(readFileSync(`${FRONTEND_ROOT}package.json`, 'utf8')) as {
      dependencies: Record<string, string>; scripts: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@xterm/xterm'], PATCHED_XTERM_VERSION, 'the patch only fits this exact version');
    assert.match(pkg.scripts.postinstall, /node patches\/xterm-composition\.mjs/);
    // A build on an existing node_modules skips the install, so the build applies it too.
    assert.match(pkg.scripts.prebuild, /node patches\/xterm-composition\.mjs/);
    for (const bundle of ['xterm.js', 'xterm.mjs']) {
      const path = `${FRONTEND_ROOT}node_modules/@xterm/xterm/lib/${bundle}`;
      assert.ok(existsSync(path), path);
      assert.ok(readFileSync(path, 'utf8').includes(PATCH_MARKER), `${bundle} is not patched by the current revision`);
    }
  });
});
