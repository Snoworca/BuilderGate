// FR-FEX-021 AC-4: downloads one file to the device. The token request carries the JWT; the
// download is a plain link to the token URL, so the browser streams the file to disk itself
// (desktop and mobile) instead of the page holding it in memory.
import { fileApi } from '../../services/api.ts';

export async function startFileDownload(sessionId: string, path: string): Promise<void> {
  const { url } = await fileApi.createDownloadToken(sessionId, path);
  const link = document.createElement('a');
  link.href = url;
  // No `download` attribute: WebKit ignores a scripted click on such a link once the gesture
  // has passed through an await (measured on Playwright's WebKit). The response's
  // Content-Disposition: attachment already makes it a download that keeps the page, and names it.
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
