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
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { CryptoService } from './CryptoService.js';
import type { TOTPConfig } from '../types/config.types.js';
import type { OTPData } from '../types/auth.types.js';

const DEFAULT_SECRET_FILE_PATH = path.join(process.cwd(), 'data', 'totp.secret');
const BASE32_REGEX = /^[A-Z2-7]+=*$/;
const TOTP_WINDOW = 1; // NFR-304: ±1 time step (±30 seconds)

const OTP_EXPIRY_MS = 300000; // 5 minutes
const MAX_PENDING_AUTH = 100;

export class TOTPService {
  private secret: string | null = null;
  private registered: boolean = false;
  private readonly otpStore = new Map<string, OTPData>();
  // ⚠️ lastUsedStep은 TOTPService 멤버가 아님 — OTPData.totpLastUsedStep 필드로 관리 (NFR-105)
  // 이유: tempToken마다 별도 추적 필요, TOTPService 멤버로 관리 시 단일 세션만 지원

  constructor(
    private readonly config: TOTPConfig,
    private readonly cryptoService: CryptoService,
    private readonly secretFilePath: string = DEFAULT_SECRET_FILE_PATH
  ) {}

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
        this.printQRCode();
      } catch (err) {
        console.error('[TOTP] TOTP secret file is corrupted or cannot be decrypted.');
        console.error('[TOTP] Delete data/totp.secret and restart to re-register.');
        throw err;
      }
    }
  }

  /**
   * FR-201: Generate a new TOTP secret, encrypt and save to file.
   */
  private createAndSaveSecret(): void {
    const newSecret = generateSecret(); // BASE32, 20 bytes

    const dir = path.dirname(this.secretFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const encrypted = this.cryptoService.encrypt(newSecret);
    fs.writeFileSync(this.secretFilePath, encrypted, 'utf-8');

    // FR-203: restrict file permissions on Linux/Mac
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

    console.log('[TOTP] Google Authenticator QR Code:');
    qrcode.generate(uri, { small: true });
    console.log(`[TOTP] Manual entry key: ${this.secret}`);
    console.log(`[TOTP] Issuer: ${issuer} | Account: ${accountName}`);
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
