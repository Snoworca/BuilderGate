/**
 * Two-Factor Authentication Form
 * Phase 7: Frontend Security
 */

import { useState, useEffect } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { t } from '../../i18n/i18n.ts';
import { Icon } from '../common/Icon';
import { Button, Field, Spinner, TextInput } from '../ui';
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
          <span className="auth-logo-icon auth-logo-tile"><Icon name="lock" size={32} /></span>
          <h1>{t('auth.twoFactor.title')}</h1>
        </div>

        <p className="auth-info">{t('auth.twoFactor.info')}</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <Field label={t('auth.twoFactor.code')} htmlFor="otp">
            <TextInput
              id="otp"
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
          </Field>

          <Button
            type="submit"
            variant="primary"
            className="auth-button"
            disabled={isLoading || otpCode.length !== 6}
          >
            {isLoading ? (
              <>
                <Spinner />
                {t('auth.twoFactor.verifying')}
              </>
            ) : (
              t('auth.twoFactor.submit')
            )}
          </Button>

          {error && (
            <div className="auth-error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          )}

          <Button
            variant="secondary"
            className="auth-link"
            onClick={logout}
            disabled={isLoading}
          >
            {t('auth.twoFactor.cancel')}
          </Button>
        </form>
      </div>
    </div>
  );
}
