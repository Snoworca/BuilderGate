// FR-FEX-021 AC-4: downloads one file to the device. The token request carries the JWT; the
// download is a plain link to the token URL, so the browser streams the file to disk itself
// (desktop and mobile) instead of the page holding it in memory.
import { fileApi } from '../../services/api.ts';

export async function startFileDownload(sessionId: string, path: string): Promise<void> {
  const { url, name } = await fileApi.createDownloadToken(sessionId, path);
  const link = document.createElement('a');
  link.href = url;
  // The server's Content-Disposition names the file; this is the hint for browsers that read it.
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
