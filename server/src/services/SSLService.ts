/**
 * SSL/TLS Service for BuilderGate Server
 * Phase 1: Security Infrastructure
 *
 * Handles SSL certificate loading, self-signed certificate generation,
 * and TLS configuration.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as tls from 'tls';
import * as crypto from 'crypto';
import selfsigned from 'selfsigned';
import type { SSLConfig, SSLCredentials, CertExpiryInfo } from '../types/config.types.js';
import { SSL_DEFAULTS, TLS_CONFIG, CIPHER_SUITES } from '../utils/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class SSLService {
  private config: SSLConfig;
  private serverRoot: string;

  constructor(config: SSLConfig) {
    this.config = config;
    // Server root is two levels up from services directory
    this.serverRoot = join(__dirname, '../..');
  }

  /**
   * Load SSL certificates from configured paths or generate self-signed (async)
   */
  async loadCertificates(): Promise<SSLCredentials> {
    const { certPath, keyPath, caPath } = this.config;

    // If paths are empty, generate self-signed certificate
    if (!certPath || !keyPath) {
      console.log('[SSL] No certificate configured, generating self-signed certificate...');
      return this.generateSelfSigned();
    }

    // Resolve paths relative to server root
    const resolvedCertPath = this.resolvePath(certPath);
    const resolvedKeyPath = this.resolvePath(keyPath);

    // Check if files exist
    if (!existsSync(resolvedCertPath)) {
      throw new Error(`Certificate file not found: ${resolvedCertPath}`);
    }
    if (!existsSync(resolvedKeyPath)) {
      throw new Error(`Key file not found: ${resolvedKeyPath}`);
    }

    // Load certificate and key
    const cert = readFileSync(resolvedCertPath, 'utf-8');
    const key = readFileSync(resolvedKeyPath, 'utf-8');

    // Validate certificate-key pair
    this.validateCertKeyPair(cert, key);

    // Load CA chain if provided
    let ca: string | undefined;
    if (caPath) {
      const resolvedCaPath = this.resolvePath(caPath);
      if (existsSync(resolvedCaPath)) {
        ca = readFileSync(resolvedCaPath, 'utf-8');
      }
    }

    console.log(`[SSL] Loaded certificate from ${resolvedCertPath}`);

    // Check expiry
    const expiryInfo = this.checkCertExpiry(cert);
    if (expiryInfo.isExpiringSoon) {
      console.warn(`[SSL] WARNING: Certificate expires in ${expiryInfo.daysRemaining} days`);
    }

    return { cert, key, ca };
  }

  /**
   * Generate a self-signed certificate for development/testing
   */
  async generateSelfSigned(): Promise<SSLCredentials> {
    const certDir = join(this.serverRoot, SSL_DEFAULTS.CERT_DIRECTORY);
    const certPath = join(certDir, SSL_DEFAULTS.CERT_FILENAME);
    const keyPath = join(certDir, SSL_DEFAULTS.KEY_FILENAME);

    // Check if self-signed certificate already exists
    if (existsSync(certPath) && existsSync(keyPath)) {
      console.log('[SSL] Using existing self-signed certificate');
      const cert = readFileSync(certPath, 'utf-8');
      const key = readFileSync(keyPath, 'utf-8');

      // Check if existing certificate is still valid
      const expiryInfo = this.checkCertExpiry(cert);
      if (expiryInfo.daysRemaining > 0) {
        if (expiryInfo.isExpiringSoon) {
          console.warn(`[SSL] WARNING: Self-signed certificate expires in ${expiryInfo.daysRemaining} days`);
        }
        return { cert, key };
      }

      console.log('[SSL] Existing certificate expired, generating new one...');
    }

    // Create certificate directory if it doesn't exist
    if (!existsSync(certDir)) {
      mkdirSync(certDir, { recursive: true });
    }

    // Generate self-signed certificate
    // Use shortName format for X.509 attributes
    const attrs = [
      { shortName: 'CN', value: 'localhost' },
      { shortName: 'O', value: 'BuilderGate' },
      { shortName: 'OU', value: 'Development' }
    ];

    // Calculate validity dates
    const notBeforeDate = new Date();
    const notAfterDate = new Date();
    notAfterDate.setDate(notAfterDate.getDate() + SSL_DEFAULTS.CERT_VALIDITY_DAYS);

    const pems = await selfsigned.generate(attrs, {
      keySize: SSL_DEFAULTS.RSA_KEY_SIZE,
      notBeforeDate,
      notAfterDate,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'basicConstraints',
          cA: false
        },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true
        },
        {
          name: 'extKeyUsage',
          serverAuth: true
        },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },     // DNS
            { type: 7, ip: '127.0.0.1' },        // IP
            { type: 7, ip: '::1' }               // IPv6
          ]
        }
      ]
    });

    // Save certificate and key
    writeFileSync(certPath, pems.cert);
    writeFileSync(keyPath, pems.private);

    console.log(`[SSL] Generated self-signed certificate:`);
    console.log(`  - Certificate: ${certPath}`);
    console.log(`  - Private key: ${keyPath}`);
    console.log(`  - Valid for: ${SSL_DEFAULTS.CERT_VALIDITY_DAYS} days`);
    console.log(`  - SAN: localhost, 127.0.0.1, ::1`);

    return {
      cert: pems.cert,
      key: pems.private
    };
  }

  /**
   * Check certificate expiry status
   */
  checkCertExpiry(certPem?: string): CertExpiryInfo {
    let cert = certPem;

    if (!cert) {
      const certPath = this.config.certPath
        ? this.resolvePath(this.config.certPath)
        : join(this.serverRoot, SSL_DEFAULTS.CERT_DIRECTORY, SSL_DEFAULTS.CERT_FILENAME);

      if (!existsSync(certPath)) {
        throw new Error('No certificate to check');
      }
      cert = readFileSync(certPath, 'utf-8');
    }

    // Parse certificate to get expiry date
    const x509 = new crypto.X509Certificate(cert);
    const expiresAt = new Date(x509.validTo);
    const now = new Date();
    const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const isExpiringSoon = daysRemaining <= SSL_DEFAULTS.CERT_EXPIRY_WARNING_DAYS;

    return {
      expiresAt,
      daysRemaining,
      isExpiringSoon
    };
  }

  /**
   * Get TLS options for HTTPS server
   */
  getTLSOptions(credentials: SSLCredentials): tls.SecureContextOptions {
    const options: tls.SecureContextOptions = {
      cert: credentials.cert,
      key: credentials.key,
      minVersion: TLS_CONFIG.MIN_VERSION,
      maxVersion: TLS_CONFIG.MAX_VERSION,
      ciphers: CIPHER_SUITES.join(':'),
      honorCipherOrder: true
    };

    if (credentials.ca) {
      options.ca = credentials.ca;
    }

    return options;
  }

  /**
   * Validate that certificate and key are a matching pair
   */
  private validateCertKeyPair(certPem: string, keyPem: string): void {
    try {
      const x509 = new crypto.X509Certificate(certPem);
      const publicKey = x509.publicKey;

      // Create a private key object
      const privateKey = crypto.createPrivateKey(keyPem);

      // Test by signing and verifying
      const testData = 'test';
      const signature = crypto.sign('sha256', Buffer.from(testData), privateKey);
      const isValid = crypto.verify('sha256', Buffer.from(testData), publicKey, signature);

      if (!isValid) {
        throw new Error('Certificate and key pair mismatch');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Certificate and key pair mismatch') {
        throw error;
      }
      throw new Error(`Failed to validate certificate-key pair: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Resolve path relative to server root
   */
  private resolvePath(path: string): string {
    if (path.startsWith('/') || path.match(/^[A-Za-z]:/)) {
      return path; // Absolute path
    }
    return join(this.serverRoot, path);
  }
}
