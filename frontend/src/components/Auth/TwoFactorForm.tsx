/**
 * Two-Factor Authentication Form
 * Phase 7: Frontend Security
 */

import { useState, useEffect } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './Auth.css';

export function TwoFactorForm() {
  const [otpCode, setOtpCode] = useState('');
  const { verify2FA, isLoading, error, logout } = useAuth();

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

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="auth-logo-icon">&#x1F510;</span>
          <h1>Authenticator Code</h1>
        </div>

        <p className="auth-info">Enter the 6-digit code from your authenticator app.</p>

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
