/**
 * Two-Factor Authentication Form
 * Phase 7: Frontend Security
 */

import { useState, useEffect } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './Auth.css';

const OTP_EXPIRY_MS = 300000; // 5 minutes (from backend config)

export function TwoFactorForm() {
  const [otpCode, setOtpCode] = useState('');
  const [timeLeft, setTimeLeft] = useState(OTP_EXPIRY_MS);
  const { verify2FA, maskedEmail, isLoading, error, logout } = useAuth();

  // Countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1000) {
          logout(); // Return to login on expiry
          return 0;
        }
        return t - 1000;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [logout]);

  // Auto-submit on 6 digits
  useEffect(() => {
    if (otpCode.length === 6 && !isLoading) {
      verify2FA(otpCode);
    }
  }, [otpCode, isLoading, verify2FA]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setOtpCode(value);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (otpCode.length !== 6) return;
    await verify2FA(otpCode);
  };

  const formatTime = (ms: number): string => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="auth-logo-icon">&#x1F510;</span>
          <h1>Verification</h1>
        </div>

        <p className="auth-info">
          Verification code sent to <strong>{maskedEmail}</strong>
        </p>

        <div className={`auth-countdown ${timeLeft < 60000 ? 'warning' : ''}`}>
          Expires in: {formatTime(timeLeft)}
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="otp">6-Digit Code</label>
            <input
              id="otp"
              type="text"
              value={otpCode}
              onChange={handleChange}
              placeholder="000000"
              disabled={isLoading}
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              className="otp-input"
              autoComplete="one-time-code"
            />
          </div>

          <button
            type="submit"
            className="auth-button"
            disabled={isLoading || otpCode.length !== 6}
          >
            {isLoading ? (
              <>
                <span className="spinner"></span>
                Verifying...
              </>
            ) : (
              'Verify'
            )}
          </button>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="button"
            className="auth-link"
            onClick={logout}
            disabled={isLoading}
          >
            Cancel and return to login
          </button>
        </form>
      </div>
    </div>
  );
}
