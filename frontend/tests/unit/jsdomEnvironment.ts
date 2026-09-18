// jsdom global bootstrap for component-render tests.
//
// This file exists because FR-BGSTAB-021's TerminalView half had no way to EXECUTE
// the component: the coordinator tests never load TerminalView.tsx, and the
// TerminalView tests only read it as text. See issue #87.
import { JSDOM } from 'jsdom';

let installed = false;

export function installJsdomEnvironment(): void {
  if (installed) return;
  installed = true;

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://localhost:2222/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const carried = [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLTextAreaElement',
    'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'WheelEvent', 'TouchEvent',
    'CustomEvent', 'ClipboardEvent', 'DOMRect', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'MutationObserver', 'localStorage', 'sessionStorage', 'DataTransfer',
  ] as const;
  for (const key of carried) {
    const value = (window as unknown as Record<string, unknown>)[key];
    if ((globalThis as Record<string, unknown>)[key] === undefined && value !== undefined) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }

  if (!(globalThis as Record<string, unknown>).ResizeObserver) {
    class StubResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as Record<string, unknown>).ResizeObserver = StubResizeObserver;
    (window as unknown as Record<string, unknown>).ResizeObserver = StubResizeObserver;
  }

  if (!(globalThis as Record<string, unknown>).matchMedia) {
    const matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    });
    (globalThis as Record<string, unknown>).matchMedia = matchMedia;
    (window as unknown as Record<string, unknown>).matchMedia = matchMedia;
  }

  // React 19 concurrent rendering expects this flag in a test environment.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
