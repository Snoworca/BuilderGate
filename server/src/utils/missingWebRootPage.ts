// OPS-BGSTAB-023: when the web root holds no index.html the server used to fall
// through to Express's bare "Not Found", which said nothing about where it had
// looked (#149). This page says the web files are missing; the path is shown
// only to a loopback request, since it describes the machine's file system.

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

// @req OPS-BGSTAB-023
export function renderMissingWebRootPage(indexPath: string, showPath: boolean): string {
  const detail = showPath
    ? `<p>The server looked for <code>${escapeHtml(indexPath)}</code>.</p>
<p>Reinstall BuilderGate, or rebuild the checkout (remove <code>server/dist</code> and start again), and check that no older BuilderGate process still holds this port.</p>`
    : '<p>See the server log for the path it checked.</p>';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BuilderGate: web files missing</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;">
<h1 style="font-size: 1.25rem;">BuilderGate is running, but its web files are missing</h1>
${detail}
</body>
</html>
`;
}
