/**
 * Two-Factor Authentication Service
 * Phase 3: Two-Factor Authentication
 *
 * Provides OTP generation, email delivery, and verification
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { TwoFactorConfig } from '../types/config.types.js';
import type { OTPData, PendingAuth, OTPVerifyResult } from '../types/auth.types.js';
import type { CryptoService } from './CryptoService.js';
import { ErrorCode } from '../utils/errors.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_OTP_STORE_SIZE = 1000;
const MAX_VERIFICATION_ATTEMPTS = 3;
const EMAIL_RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff

// ============================================================================
// TwoFactorService Class
// ============================================================================

export class TwoFactorService {
  private otpStore: Map<string, OTPData> = new Map();
  private smtpTransport: Transporter | null = null;
  private config: TwoFactorConfig;
  private cryptoService: CryptoService;
  private decryptedSmtpPassword: string = '';

  constructor(config: TwoFactorConfig, cryptoService: CryptoService) {
    this.config = config;
    this.cryptoService = cryptoService;

    if (config.enabled && config.smtp) {
      this.initTransport();
    }
  }

  // ==========================================================================
  // Transport Initialization
  // ==========================================================================

  private initTransport(): void {
    if (!this.config.smtp) {
      throw new Error('SMTP configuration is required for 2FA');
    }

    // Decrypt SMTP password if encrypted
    const smtpPassword = this.config.smtp.auth.password;
    this.decryptedSmtpPassword = this.cryptoService.isEncrypted(smtpPassword)
      ? this.cryptoService.decrypt(smtpPassword)
      : smtpPassword;

    this.smtpTransport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.auth.user,
        pass: this.decryptedSmtpPassword
      },
      tls: this.config.smtp.tls ? {
        rejectUnauthorized: this.config.smtp.tls.rejectUnauthorized,
        minVersion: this.config.smtp.tls.minVersion
      } : undefined
    });

    console.log('[2FA] SMTP transport initialized');
  }

  // ==========================================================================
  // OTP Generation
  // ==========================================================================

  /**
   * Generate a random OTP code
   * @returns OTP string (e.g., "123456")
   */
  generateOTP(): string {
    const length = this.config.otpLength || 6;
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    const otp = crypto.randomInt(min, max + 1);
    return otp.toString().padStart(length, '0');
  }

  // ==========================================================================
  // Pending Auth Management
  // ==========================================================================

  /**
   * Create a pending authentication request and send OTP email
   * @param email - Email address to send OTP
   * @returns PendingAuth with tempToken and maskedEmail
   */
  async createPendingAuth(email: string): Promise<PendingAuth> {
    // Clean up old entries if limit reached
    this.cleanupExpiredOTPs();
    if (this.otpStore.size >= MAX_OTP_STORE_SIZE) {
      this.removeOldestOTP();
    }

    // Generate OTP and tempToken
    const otp = this.generateOTP();
    const tempToken = crypto.randomUUID();
    const expiresAt = Date.now() + (this.config.otpExpiryMs || 300000);

    // Store OTP data
    const otpData: OTPData = {
      otp,
      email,
      expiresAt,
      attempts: 0
    };
    this.otpStore.set(tempToken, otpData);

    // Send OTP email
    const emailSent = await this.sendOTPEmail(email, otp);
    if (!emailSent) {
      this.otpStore.delete(tempToken);
      throw new Error('Failed to send OTP email');
    }

    console.log(`[2FA] Pending auth created: tempToken=${tempToken.substring(0, 8)}...`);

    return {
      tempToken,
      maskedEmail: this.maskEmail(email)
    };
  }

  // ==========================================================================
  // Email Delivery
  // ==========================================================================

  /**
   * Send OTP email with retry logic
   * @param email - Recipient email address
   * @param otp - OTP code to send
   * @returns true if sent successfully
   */
  async sendOTPEmail(email: string, otp: string): Promise<boolean> {
    if (!this.smtpTransport) {
      console.error('[2FA] SMTP transport not initialized');
      return false;
    }

    const expiryMinutes = Math.floor((this.config.otpExpiryMs || 300000) / 60000);
    const mailOptions = {
      from: this.config.smtp?.auth.user,
      to: email,
      subject: '[BuilderGate] Login Verification Code',
      text: this.getEmailTemplate(otp, expiryMinutes),
      html: this.getEmailTemplateHTML(otp, expiryMinutes)
    };

    try {
      await this.retryWithBackoff(async () => {
        await this.smtpTransport!.sendMail(mailOptions);
      });
      console.log(`[2FA] OTP email sent to ${this.maskEmail(email)}`);
      return true;
    } catch (error) {
      console.error('[2FA] Failed to send OTP email:', error);
      return false;
    }
  }

  /**
   * Retry function with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[2FA] Attempt ${attempt + 1}/${maxRetries} failed:`, lastError.message);

        if (attempt < maxRetries - 1) {
          const delay = EMAIL_RETRY_DELAYS[attempt] || 4000;
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // OTP Verification
  // ==========================================================================

  /**
   * Verify OTP code
   * @param tempToken - Temporary token from login response
   * @param otpCode - OTP code entered by user
   * @returns Verification result
   */
  verifyOTP(tempToken: string, otpCode: string): OTPVerifyResult {
    const otpData = this.otpStore.get(tempToken);

    // Check if tempToken exists
    if (!otpData) {
      return {
        success: false,
        errorCode: ErrorCode.INVALID_TEMP_TOKEN
      };
    }

    // Check expiration
    if (Date.now() > otpData.expiresAt) {
      this.otpStore.delete(tempToken);
      return {
        success: false,
        errorCode: ErrorCode.OTP_EXPIRED
      };
    }

    // Check max attempts
    if (otpData.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      this.otpStore.delete(tempToken);
      return {
        success: false,
        errorCode: ErrorCode.OTP_MAX_ATTEMPTS,
        attemptsRemaining: 0
      };
    }

    // Verify OTP using timing-safe comparison
    const isValid = this.cryptoService.timingSafeEqual(otpCode, otpData.otp);

    if (isValid) {
      // Success - delete OTP data
      this.otpStore.delete(tempToken);
      console.log(`[2FA] OTP verified successfully: tempToken=${tempToken.substring(0, 8)}...`);
      return { success: true };
    }

    // Failed - increment attempts
    otpData.attempts++;
    const attemptsRemaining = MAX_VERIFICATION_ATTEMPTS - otpData.attempts;

    if (attemptsRemaining <= 0) {
      this.otpStore.delete(tempToken);
      return {
        success: false,
        errorCode: ErrorCode.OTP_MAX_ATTEMPTS,
        attemptsRemaining: 0
      };
    }

    console.log(`[2FA] Invalid OTP attempt: ${otpData.attempts}/${MAX_VERIFICATION_ATTEMPTS}`);
    return {
      success: false,
      errorCode: ErrorCode.INVALID_OTP,
      attemptsRemaining
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Mask email address for display
   * @param email - Full email address
   * @returns Masked email (e.g., "a***@example.com")
   */
  maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    return local[0] + '***@' + domain;
  }

  /**
   * Check if 2FA is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get configured email for 2FA
   */
  getEmail(): string | undefined {
    return this.config.email;
  }

  // ==========================================================================
  // Cleanup Methods
  // ==========================================================================

  /**
   * Remove expired OTPs
   */
  private cleanupExpiredOTPs(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, data] of this.otpStore.entries()) {
      if (now > data.expiresAt) {
        this.otpStore.delete(token);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[2FA] Cleaned up ${cleaned} expired OTPs`);
    }
  }

  /**
   * Remove oldest OTP (FIFO)
   */
  private removeOldestOTP(): void {
    const firstKey = this.otpStore.keys().next().value;
    if (firstKey) {
      this.otpStore.delete(firstKey);
      console.log('[2FA] Removed oldest OTP due to store limit');
    }
  }

  // ==========================================================================
  // Email Templates
  // ==========================================================================

  private getEmailTemplate(otp: string, expiryMinutes: number): string {
    return `Your verification code is: ${otp}

This code will expire in ${expiryMinutes} minutes.

If you did not request this code, please ignore this email.
Do not share this code with anyone.

---
BuilderGate`;
  }

  private getEmailTemplateHTML(otp: string, expiryMinutes: number): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background-color: #f5f5f5;">
  <div style="max-width: 480px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="color: #333; margin-top: 0;">Login Verification</h2>
    <p style="color: #666;">Your verification code is:</p>
    <div style="background: #f0f0f0; padding: 20px; text-align: center; border-radius: 4px; margin: 20px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333;">${otp}</span>
    </div>
    <p style="color: #666; font-size: 14px;">This code will expire in <strong>${expiryMinutes} minutes</strong>.</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
    <p style="color: #999; font-size: 12px;">
      If you did not request this code, please ignore this email.<br>
      Do not share this code with anyone.
    </p>
    <p style="color: #999; font-size: 12px; margin-bottom: 0;">BuilderGate</p>
  </div>
</body>
</html>`;
  }
}
