import { useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './Auth.css';

export function BootstrapPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { bootstrapPassword, isLoading, error } = useAuth();

  const validationMessage = useMemo(() => {
    if (!password && !confirmPassword) {
      return null;
    }

    if (password.length > 0 && password.length < 4) {
      return 'Password must be at least 4 characters long.';
    }

    if (confirmPassword && password !== confirmPassword) {
      return 'Password confirmation does not match.';
    }

    return null;
  }, [confirmPassword, password]);

  const canSubmit = password.length >= 4 && password === confirmPassword;

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
          <h1>Initial Admin Password</h1>
        </div>

        <p className="auth-info">
          Set the administrator password for this BuilderGate instance.
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="bootstrap-password">Password</label>
            <input
              id="bootstrap-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter a new password"
              disabled={isLoading}
              autoFocus
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label htmlFor="bootstrap-password-confirm">Confirm Password</label>
            <input
              id="bootstrap-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Confirm the password"
              disabled={isLoading}
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            className="auth-button"
            disabled={isLoading || !canSubmit}
          >
            {isLoading ? (
              <>
                <span className="spinner"></span>
                Saving...
              </>
            ) : (
              'Set Password'
            )}
          </button>

          {validationMessage && (
            <div className="auth-error" role="alert">
              {validationMessage}
            </div>
          )}

          {!validationMessage && error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
