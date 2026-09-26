/**
 * Whether Vite may inline a built asset as a `data:` URI.
 *
 * The server sends `font-src 'self'` (server/src/middleware/securityHeaders.ts), so a font
 * inlined as `data:font/woff2;base64,...` is refused by the browser. Measured on 2026-09-19
 * against https://localhost:2222: the only console error on a logged-in page was
 * "Refused to load the font 'data:font/woff2;base64,...' because it violates the following
 * Content Security Policy directive: \"font-src 'self'\"" — one KaTeX face small enough to
 * fall under Vite's default 4KB inline threshold, so it silently fell back for every viewer.
 *
 * Emitting fonts as files rather than relaxing `font-src` to allow `data:` keeps the CSP
 * decision intact; the cost is one extra request for a file that is already cached alongside
 * its 19 siblings.
 */
export function shouldInlineAsset(filePath: string): boolean {
  return !/\.(woff2?|ttf|otf|eot)$/iu.test(filePath);
}
