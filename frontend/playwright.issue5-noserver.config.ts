import base from './playwright.config';

// Issue #5 verification lane: never auto-start a server. The external
// https://localhost:2222 listener is started and owned by the lane itself.
export default { ...base, webServer: undefined };
