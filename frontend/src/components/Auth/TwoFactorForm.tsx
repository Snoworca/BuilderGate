/**
 * Two-Factor Authentication Form
 * Phase 7: Frontend Security
 */

import { useState, useEffect } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
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
          <h1>인증 코드 입력</h1>
        </div>

        <p className="auth-info">인증 앱에 보이는 6자리 코드를 입력하세요. 6자리를 모두 넣으면 바로 확인합니다.</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <Field label="인증 코드" htmlFor="otp">
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
                확인하는 중…
              </>
            ) : (
              '코드 확인'
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
            취소하고 로그인 화면으로
          </Button>
        </form>
      </div>
    </div>
  );
}
