/**
 * Login Form Component
 * Phase 7: Frontend Security
 */

import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
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
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter password"
              disabled={isLoading}
              autoFocus
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="auth-button"
            disabled={isLoading || !password.trim()}
          >
            {isLoading ? (
              <>
                <span className="spinner"></span>
                Logging in...
              </>
            ) : (
              'Login'
            )}
          </button>

          {(error || bootstrapError) && (
            <div className="auth-error" role="alert">
              {error || bootstrapError}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
