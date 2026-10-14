// FR-BGSTAB-034: with auth.localhostNoAuth on, the server issues a token to a browser on this
// computer without a password. Any refusal or failure leaves the login screen as it was.
import type { LoginResponse } from '../types';

export async function tryLocalLogin(
  request: () => Promise<LoginResponse>,
  storage: { setToken: (token: string, expiresIn: number) => void },
): Promise<boolean> {
  try {
    const response = await request();
    if (!response.token || !response.expiresIn) return false;
    storage.setToken(response.token, response.expiresIn);
    return true;
  } catch {
    return false;
  }
}
