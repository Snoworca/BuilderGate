// FR-UIDS-015: when the app shows its mobile layout. Width alone turned a phone held in landscape
// (800-930 px wide, 360-430 px high) into the desktop layout; a touch screen that short is a phone.
// Tablets in landscape and touch-screen laptops are taller and keep the desktop layout. The width
// cap (a phone in landscape is at most ~932 px wide, a tablet 1024 px and up) keeps a tablet
// desktop when an on-screen keyboard shrinks its layout viewport below 500 px high.
//
// The stylesheets cannot import this, so each `@media` rule that switches layouts repeats it
// verbatim; tests/unit/mobileLayoutQuery.test.ts holds them to this text.
// @req FR-UIDS-015
export const MOBILE_LAYOUT_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px) and (max-width: 950px)';
