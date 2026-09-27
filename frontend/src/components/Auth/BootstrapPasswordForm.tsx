import { useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { t } from '../../i18n/i18n.ts';
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
      return t('auth.bootstrap.mismatch');
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
          <h1>{t('auth.bootstrap.title')}</h1>
        </div>

        <p className="auth-info">
          {t('auth.bootstrap.info')}
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <Field label={t('auth.field.password')} htmlFor="bootstrap-password">
            <TextInput
              id="bootstrap-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('auth.bootstrap.passwordPlaceholder')}
              disabled={isLoading}
              autoFocus
              autoComplete="new-password"
            />
          </Field>

          <Field label={t('auth.bootstrap.confirm')} htmlFor="bootstrap-password-confirm">
            <TextInput
              id="bootstrap-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('auth.bootstrap.confirmPlaceholder')}
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
                {t('auth.bootstrap.submitting')}
              </>
            ) : (
              t('auth.bootstrap.submit')
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
