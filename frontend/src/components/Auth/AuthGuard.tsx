/**
 * Auth Guard Component
 * Phase 7: Frontend Security
 *
 * Wraps protected content and shows login/2FA forms when needed
 */

import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { t } from '../../i18n/i18n.ts';
import { Icon } from '../common/Icon';
import { Spinner } from '../ui';
import { BootstrapPasswordForm } from './BootstrapPasswordForm';
import { LoginForm } from './LoginForm';
import { TwoFactorForm } from './TwoFactorForm';
import './Auth.css';

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading, requires2FA, bootstrapStatus, bootstrapError } = useAuth();

  if (isLoading) {
    return (
      <div className="auth-container">
        <div className="auth-loading" role="status">
          <span className="auth-spinner-large"><Spinner /></span>
          <p>{t('auth.guard.checking')}</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (requires2FA) {
      return <TwoFactorForm />;
    }
    if (bootstrapStatus?.setupRequired && bootstrapStatus.requesterAllowed) {
      return <BootstrapPasswordForm />;
    }
    if (bootstrapStatus?.setupRequired && !bootstrapStatus.requesterAllowed) {
      return (
        <div className="auth-container">
          <div className="auth-card">
            <div className="auth-logo">
              <img src="/logo.svg" alt="BuilderGate" className="auth-logo-icon" width="64" height="64" />
              <h1>{t('auth.guard.bootstrapBlockedTitle')}</h1>
            </div>
            <p className="auth-info">
              {t('auth.guard.noPassword')}
            </p>
            <div className="auth-warning" role="alert">
              <Icon name="alert" />
              <span>{t('auth.guard.bootstrapLocalOnly')}</span>
            </div>
            {bootstrapError && (
              <div className="auth-error" role="alert">
                <Icon name="alert" />
                <span>{bootstrapError}</span>
              </div>
            )}
          </div>
        </div>
      );
    }
    return <LoginForm />;
  }

  return <>{children}</>;
}
