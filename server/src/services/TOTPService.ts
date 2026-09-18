/**
 * TOTPService — Time-based One-Time Password (RFC 6238)
 * Step 6: Google Authenticator integration
 *
 * FR-101: TOTPService class
 * FR-102: QR code output on server start
 * FR-103: Detect unregistered TOTP state
 * FR-201: Auto-generate secret on first start
 * FR-202: Load existing secret from file
 * FR-203: File permission (0o600)
 * FR-204: Abort server start on corrupted secret
 * FR-402: isRegistered() check
 * NFR-101: Timing-safe verification (otplib internal)
 * NFR-102: Encrypted secret storage
 * NFR-104: Max 3 verification attempts
 * NFR-105: Replay prevention via OTPData.totpLastUsedStep
 */

import { generateSecret, generateURI, verifySync } from 'otplib';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, webcrypto } from 'crypto';
import type { CryptoService } from './CryptoService.js';
import type { TwoFactorConfig } from '../types/config.types.js';
import type { OTPData } from '../types/auth.types.js';

const DEFAULT_SECRET_FILE_PATH = path.join(process.cwd(), 'data', 'totp.secret');
const BASE32_REGEX = /^[A-Z2-7]+=*$/;
const TOTP_WINDOW = 1; // NFR-304: ±1 time step (±30 seconds)

const OTP_EXPIRY_MS = 300000; // 5 minutes
const MAX_PENDING_AUTH = 100;

export type ConsoleQrWriter = (uri: string, options: { small: boolean }) => void;

export interface TOTPServiceOptions {
  printConsoleQr?: boolean;
  qrCodeWriter?: ConsoleQrWriter;
}

const DEFAULT_CONSOLE_QR_WRITER: ConsoleQrWriter = (uri, options) => {
  qrcode.generate(uri, options);
};

function ensureWebCryptoGetRandomValues(): void {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return;
  }

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    enumerable: true,
    value: webcrypto,
  });
}

export class TOTPService {
  private secret: string | null = null;
  private registered: boolean = false;
  // #80: renamed and inverted. The old name defaulted to printing, so the safe state was the
  // one you had to ask for. Now printing is the state you ask for.
  private readonly printConsoleQr: boolean;
  private readonly qrCodeWriter: ConsoleQrWriter;
  private readonly otpStore = new Map<string, OTPData>();
  // ⚠️ lastUsedStep은 TOTPService 멤버가 아님 — OTPData.totpLastUsedStep 필드로 관리 (NFR-105)
  // 이유: tempToken마다 별도 추적 필요, TOTPService 멤버로 관리 시 단일 세션만 지원

  constructor(
    private readonly config: Pick<TwoFactorConfig, 'enabled' | 'issuer' | 'accountName'>,
    private readonly cryptoService: CryptoService,
    private readonly secretFilePath: string = DEFAULT_SECRET_FILE_PATH,
    options: TOTPServiceOptions = {},
  ) {
    this.printConsoleQr = options.printConsoleQr ?? false;
    this.qrCodeWriter = options.qrCodeWriter ?? DEFAULT_CONSOLE_QR_WRITER;
  }

  /**
   * Initialize TOTP service: load existing secret or generate new one.
   * Called once at server startup.
   * Throws on corrupted secret file (FR-204).
   */
  initialize(): void {
    if (!fs.existsSync(this.secretFilePath)) {
      console.log('[TOTP] No secret file found. Generating new secret...');
      this.createAndSaveSecret();
      this.printQRCode();
    } else {
      try {
        this.loadSecret();
      } catch (err) {
        console.error('[TOTP] TOTP secret file is corrupted or cannot be decrypted.');
        console.error('[TOTP] Delete data/totp.secret and restart to re-register.');
        throw err;
      }
      this.printQRCode();
    }
  }

  /**
   * FR-201: Generate a new TOTP secret, encrypt and save to file.
   */
  private createAndSaveSecret(): void {
    ensureWebCryptoGetRandomValues();
    const newSecret = generateSecret(); // BASE32, 20 bytes

    const dir = path.dirname(this.secretFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const encrypted = this.cryptoService.encrypt(newSecret);
    // #58: mode is set AT CREATION, not after the write. chmod-after-write leaves the file at
    // the umask default in between -- 0644 under a common umask 022 -- so another user on the
    // same machine can read an encrypted credential during that window. Passing mode to the
    // create call closes it because the kernel applies it before any bytes exist.
    //
    // Written through a temp file in the same directory and renamed, so a crash mid-write
    // cannot leave a half-file that looks like a credential. The temp carries the same 0600
    // from creation for the same reason -- a temp file holding a credential is a credential.
    //
    // NOT addressed here, and stated rather than implied: two processes bootstrapping an
    // empty checkout concurrently still generate two different secrets, and the loser keeps an
    // in-memory secret that no longer matches the file. Atomic publication does not decide
    // WHICH secret wins or how the loser reloads; that is a separate decision and #58 says so.
    const tempPath = `${this.secretFilePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, encrypted, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tempPath, this.secretFilePath);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* the original error is the one to raise */ }
      throw error;
    }

    // rename preserves the destination inode's mode when it already existed, so an older file
    // created before this fix keeps its old permissions. Re-assert them.
    if (process.platform !== 'win32') {
      fs.chmodSync(this.secretFilePath, 0o600);
    }

    this.secret = newSecret;
    this.registered = true;
    console.log('[TOTP] New secret generated and saved.');
  }

  /**
   * FR-202: Load and decrypt existing TOTP secret from file.
   * Throws if file content is invalid (FR-204).
   */
  private loadSecret(): void {
    const content = fs.readFileSync(this.secretFilePath, 'utf-8').trim();
    const decrypted = this.cryptoService.decrypt(content);

    if (!BASE32_REGEX.test(decrypted)) {
      throw new Error('[TOTP] Secret file has invalid BASE32 format.');
    }

    this.secret = decrypted;
    this.registered = true;
  }

  /**
   * FR-102: Print QR code to console for Google Authenticator setup.
   */
  printQRCode(): void {
    if (!this.secret) return;

    const issuer = this.config.issuer ?? 'BuilderGate';
    const accountName = this.config.accountName ?? 'admin';
    // otplib v12: generateURI uses 'label' not 'accountName', format is "issuer:label"
    const uri = generateURI({ secret: this.secret, issuer, label: `${issuer}:${accountName}` });

    // #80: the secret itself is NEVER printed, under any flag. A TOTP secret is the whole of
    // the second factor -- anyone who can read the log can mint valid codes forever, which
    // defeats the thing 2FA exists to do after a password leak. The exposure surface is wide:
    // every test and CI run that boots the server, redirected log files, the daemon's rotated
    // logs, and evidence bundles (#40 collected four such logs and had to redact them).
    //
    // The QR is equally sensitive -- it encodes the same secret and is scannable straight off
    // a screenshot -- so it is now opt-IN. It used to be opt-out via BUILDERGATE_SUPPRESS_TOTP_QR,
    // which meant the safe behaviour required someone to have set an environment variable.
    // A secret that leaks unless you remember a flag is a secret that leaks.
    console.log(`[TOTP] Two-factor is configured for ${issuer} | Account: ${accountName}`);

    // The QR encodes the secret and is scannable straight off a screenshot, so it prints only
    // when someone asked for it -- the daemon preflight, which exists to be scanned, or an
    // explicit BUILDERGATE_PRINT_TOTP_QR=1. It used to be opt-OUT, which made the safe state
    // the one you had to remember. A secret that leaks unless you remember a flag is a secret
    // that leaks.
    if (!this.printConsoleQr) {
      console.log('[TOTP] The enrolment QR is not written to this log. '
        + 'Set BUILDERGATE_PRINT_TOTP_QR=1 to print it, or read it from the settings UI.');
      return;
    }

    console.log('[TOTP] Google Authenticator QR Code:');
    this.qrCodeWriter(uri, { small: true });
    // The SECRET is never printed, under any flag. The QR is a credential the operator is
    // actively scanning; the manual key is a credential sitting in a log forever, and anyone
    // who can read it can mint valid codes indefinitely -- which is the thing 2FA exists to
    // prevent after a password leak. #40 collected four such logs and had to redact them.
  }

  /**
   * Generate a QR code data URL for the TOTP URI.
   * Used by the /api/auth/totp-qr endpoint to return a scannable QR image.
   * @returns { dataUrl, uri, registered }
   */
  async generateQRDataUrl(): Promise<{ dataUrl: string; uri: string; registered: boolean }> {
    if (!this.secret || !this.registered) {
      return { dataUrl: '', uri: '', registered: false };
    }
    const issuer = this.config.issuer ?? 'BuilderGate';
    const accountName = this.config.accountName ?? 'admin';
    const uri = generateURI({ secret: this.secret, issuer, label: `${issuer}:${accountName}` });
    const dataUrl = await QRCode.toDataURL(uri, { width: 256, margin: 2 });
    return { dataUrl, uri, registered: true };
  }

  /**
   * FR-402: Check if TOTP has been registered (secret exists and loaded).
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Create a pending auth session for TOTP verification.
   * Returns a tempToken to be sent to the client.
   */
  createPendingAuth(): { tempToken: string } {
    this.cleanupExpiredOTPs();
    if (this.otpStore.size >= MAX_PENDING_AUTH) {
      throw new Error('[TOTP] Too many pending auth sessions');
    }
    const tempToken = randomUUID();
    const otpData: OTPData = {
      otp: '',
      expiresAt: Date.now() + OTP_EXPIRY_MS,
      attempts: 0,
      stage: 'totp',
    };
    this.otpStore.set(tempToken, otpData);
    return { tempToken };
  }

  /**
   * Retrieve OTP data for a given tempToken.
   */
  getOTPData(tempToken: string): OTPData | undefined {
    return this.otpStore.get(tempToken);
  }

  /**
   * Remove a pending auth entry (on success or max-attempts exceeded).
   */
  invalidatePendingAuth(tempToken: string): void {
    this.otpStore.delete(tempToken);
  }

  /**
   * Clean up expired OTP entries.
   */
  private cleanupExpiredOTPs(): void {
    const now = Date.now();
    for (const [token, data] of this.otpStore.entries()) {
      if (now > data.expiresAt) {
        this.otpStore.delete(token);
      }
    }
  }

  /**
   * FR-101 + NFR-101 + NFR-104 + NFR-105: Verify a TOTP code.
   * Uses OTPData.totpLastUsedStep for per-session replay prevention.
   *
   * Side effects on otpData (caller-owned, passed by reference):
   *   - Increments otpData.attempts on each invalid verification (NFR-104)
   *   - Sets otpData.totpLastUsedStep on successful verification (NFR-105)
   *
   * @param code - 6-digit TOTP code from authenticator app
   * @param otpData - Current session OTP data (mutated: attempts++, totpLastUsedStep set)
   * @returns { valid: boolean } — true if code is correct and not replayed
   */
  verifyTOTP(code: string, otpData: OTPData): { valid: boolean } {
    if (!this.secret || !this.registered) return { valid: false };

    // NFR-104: max 3 attempts per tempToken
    if (otpData.attempts >= 3) return { valid: false };

    // NFR-105: replay prevention via afterTimeStep (rejects codes at or before lastUsedStep)
    // NFR-101: otplib verifySync uses timing-safe comparison internally
    const lastUsed = otpData.totpLastUsedStep ?? 0;
    const result = verifySync({
      token: code,
      secret: this.secret,
      epochTolerance: TOTP_WINDOW * 30, // ±30 seconds (1 time step)
      afterTimeStep: lastUsed > 0 ? lastUsed : undefined,
    });

    if (!result.valid) {
      // NFR-104: increment attempt counter on failure (caller reads this to report attemptsRemaining)
      otpData.attempts++;
      if (lastUsed > 0) console.warn('[TOTP] Code replay detected or invalid');
      return { valid: false };
    }

    // NFR-105: record used step to prevent replay in subsequent calls
    otpData.totpLastUsedStep = Math.floor(Date.now() / 30000);
    return { valid: true };
  }

  /**
   * Clean up sensitive data from memory.
   */
  destroy(): void {
    this.secret = null;
    this.registered = false;
  }
}
