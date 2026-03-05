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
  const { login, isLoading, error } = useAuth();

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
          <span className="auth-logo-icon">&#x1F4BB;</span>
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

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
