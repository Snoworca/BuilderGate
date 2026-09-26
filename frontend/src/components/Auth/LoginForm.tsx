/**
 * Login Form Component
 * Phase 7: Frontend Security
 */

import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Icon } from '../common/Icon';
import { Button, Field, Spinner, TextInput } from '../ui';
import './Auth.css';

export function LoginForm() {
  const [password, setPassword] = useState('');
  const { login, isLoading, error, bootstrapError } = useAuth();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    await login(password);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading && password.trim()) {
      handleSubmit(e);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/logo.svg" alt="BuilderGate" className="auth-logo-icon" width="64" height="64" />
          <h1>BuilderGate</h1>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <Field label="비밀번호" htmlFor="password">
            <TextInput
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="비밀번호 입력"
              disabled={isLoading}
              autoFocus
              autoComplete="current-password"
            />
          </Field>

          <Button
            type="submit"
            variant="primary"
            className="auth-button"
            disabled={isLoading || !password.trim()}
          >
            {isLoading ? (
              <>
                <Spinner />
                로그인하는 중…
              </>
            ) : (
              '로그인'
            )}
          </Button>

          {(error || bootstrapError) && (
            <div className="auth-error" role="alert">
              <Icon name="alert" />
              <span>{error || bootstrapError}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
