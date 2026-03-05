/**
 * Cryptographic Service
 * Phase 2: Authentication Core
 *
 * Provides AES-256-GCM encryption with PBKDF2 key derivation
 */

import * as crypto from 'crypto';
import { AppError, ErrorCode } from '../utils/errors.js';

// ============================================================================
// Constants
// ============================================================================

const ENCRYPTION_PREFIX = 'enc(';
const ENCRYPTION_SUFFIX = ')';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha256';

export class CryptoService {
  private masterKey: Buffer;

  /**
   * Create a CryptoService instance
   * @param masterKeySource - Source for master key derivation (e.g., machine ID, env var)
   */
  constructor(masterKeySource: string) {
    // Derive master key from source using a fixed salt for consistency
    const fixedSalt = Buffer.from('buildergate-master-key-salt-v1', 'utf-8');
    this.masterKey = crypto.pbkdf2Sync(
      masterKeySource,
      fixedSalt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
  }

  /**
   * Encrypt plaintext using AES-256-GCM
   * @param plaintext - Text to encrypt
   * @returns Encrypted string in format: enc(base64(salt + iv + authTag + ciphertext))
   */
  encrypt(plaintext: string): string {
    try {
      // Generate random salt and IV
      const salt = crypto.randomBytes(SALT_LENGTH);
      const iv = crypto.randomBytes(IV_LENGTH);

      // Derive encryption key from master key using the salt
      const key = this.deriveKey(this.masterKey, salt);

      // Create cipher
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

      // Encrypt
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf-8'),
        cipher.final()
      ]);

      // Get auth tag
      const authTag = cipher.getAuthTag();

      // Combine: salt + iv + authTag + ciphertext
      const combined = Buffer.concat([salt, iv, authTag, ciphertext]);

      // Return in enc(...) format
      return `${ENCRYPTION_PREFIX}${combined.toString('base64')}${ENCRYPTION_SUFFIX}`;
    } catch (error) {
      throw new AppError(
        ErrorCode.ENCRYPTION_ERROR,
        `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Decrypt an encrypted string
   * @param encryptedString - String in format: enc(base64(...))
   * @returns Decrypted plaintext
   */
  decrypt(encryptedString: string): string {
    try {
      // Parse enc(...) format
      if (!this.isEncrypted(encryptedString)) {
        throw new Error('Invalid encrypted format');
      }

      // Extract base64 content
      const base64Content = encryptedString.slice(
        ENCRYPTION_PREFIX.length,
        -ENCRYPTION_SUFFIX.length
      );

      // Decode base64
      const combined = Buffer.from(base64Content, 'base64');

      // Validate minimum length
      const minLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
      if (combined.length < minLength) {
        throw new Error('Invalid encrypted data length');
      }

      // Extract components
      let offset = 0;
      const salt = combined.subarray(offset, offset + SALT_LENGTH);
      offset += SALT_LENGTH;
      const iv = combined.subarray(offset, offset + IV_LENGTH);
      offset += IV_LENGTH;
      const authTag = combined.subarray(offset, offset + AUTH_TAG_LENGTH);
      offset += AUTH_TAG_LENGTH;
      const ciphertext = combined.subarray(offset);

      // Derive key from master key using the salt
      const key = this.deriveKey(this.masterKey, salt);

      // Create decipher
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString('utf-8');

      return plaintext;
    } catch (error) {
      throw new AppError(
        ErrorCode.DECRYPTION_ERROR,
        `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check if a value is in encrypted format
   * @param value - Value to check
   * @returns True if the value is in enc(...) format
   */
  isEncrypted(value: string): boolean {
    if (!value || typeof value !== 'string') {
      return false;
    }

    // Check format
    if (!value.startsWith(ENCRYPTION_PREFIX) || !value.endsWith(ENCRYPTION_SUFFIX)) {
      return false;
    }

    // Extract and validate base64 content
    const base64Content = value.slice(
      ENCRYPTION_PREFIX.length,
      -ENCRYPTION_SUFFIX.length
    );

    // Check if it's valid base64
    try {
      const decoded = Buffer.from(base64Content, 'base64');
      // Check minimum length (salt + iv + authTag + at least 1 byte)
      return decoded.length >= SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
    } catch {
      return false;
    }
  }

  /**
   * Derive an encryption key from master key and salt
   * @param masterKey - Master key buffer
   * @param salt - Salt buffer
   * @returns Derived key buffer
   */
  deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
      masterKey,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
  }

  /**
   * Timing-safe string comparison
   * @param a - First string
   * @param b - Second string
   * @returns True if strings are equal
   */
  timingSafeEqual(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'utf-8');
      const bufB = Buffer.from(b, 'utf-8');

      // If lengths differ, we still need to do a comparison to avoid timing leak
      if (bufA.length !== bufB.length) {
        // Create a buffer of same length and compare
        // This ensures constant time regardless of length mismatch
        const maxLen = Math.max(bufA.length, bufB.length);
        const paddedA = Buffer.alloc(maxLen);
        const paddedB = Buffer.alloc(maxLen);
        bufA.copy(paddedA);
        bufB.copy(paddedB);
        crypto.timingSafeEqual(paddedA, paddedB);
        return false;
      }

      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Generate cryptographically secure random bytes
   * @param bytes - Number of bytes to generate
   * @returns Random bytes buffer
   */
  generateSecureRandom(bytes: number): Buffer {
    return crypto.randomBytes(bytes);
  }

  /**
   * Generate a secure random string (base64url encoded)
   * @param bytes - Number of random bytes (output will be longer due to encoding)
   * @returns Random string
   */
  generateSecureRandomString(bytes: number = 32): string {
    return this.generateSecureRandom(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Clear sensitive data from a buffer
   * @param buffer - Buffer to clear
   */
  clearBuffer(buffer: Buffer): void {
    buffer.fill(0);
  }
}
