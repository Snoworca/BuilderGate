import { useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { validatePasswordPolicy } from '../../utils/passwordPolicy';
import { Icon } from '../common/Icon';
import { Button, Field, Spinner, TextInput } from '../ui';
import './Auth.css';

export function BootstrapPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { bootstrapPassword, isLoading, error } = useAuth();

  const validationMessage = useMemo(() => {
    if (!password && !confirmPassword) {
      return null;
    }

    if (password.length > 0) {
      const policy = validatePasswordPolicy(password);
      if (!policy.valid) {
        return policy.message;
      }
    }

    if (confirmPassword && password !== confirmPassword) {
      return '두 비밀번호가 다릅니다. 같은 비밀번호를 다시 입력하세요.';
    }

    return null;
  }, [confirmPassword, password]);

  const canSubmit = validatePasswordPolicy(password).valid && password === confirmPassword;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    await bootstrapPassword(password, confirmPassword);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !isLoading && canSubmit) {
      handleSubmit(event);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/logo.svg" alt="BuilderGate" className="auth-logo-icon" width="64" height="64" />
          <h1>관리자 비밀번호 설정</h1>
        </div>

        <p className="auth-info">
          이 BuilderGate에 로그인할 때 쓸 관리자 비밀번호를 정합니다.
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <Field label="비밀번호" htmlFor="bootstrap-password">
            <TextInput
              id="bootstrap-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="새 비밀번호 입력"
              disabled={isLoading}
              autoFocus
              autoComplete="new-password"
            />
          </Field>

          <Field label="비밀번호 확인" htmlFor="bootstrap-password-confirm">
            <TextInput
              id="bootstrap-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="비밀번호 다시 입력"
              disabled={isLoading}
              autoComplete="new-password"
            />
          </Field>

          <Button
            type="submit"
            variant="primary"
            className="auth-button"
            disabled={isLoading || !canSubmit}
          >
            {isLoading ? (
              <>
                <Spinner />
                설정하는 중…
              </>
            ) : (
              '비밀번호 설정'
            )}
          </Button>

          {validationMessage && (
            <div className="auth-error" role="alert">
              <Icon name="alert" />
              <span>{validationMessage}</span>
            </div>
          )}

          {!validationMessage && error && (
            <div className="auth-error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
