/**
 * Auth Guard Component
 * Phase 7: Frontend Security
 *
 * Wraps protected content and shows login/2FA forms when needed
 */

import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
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
          <p>로그인 상태를 확인하는 중…</p>
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
              <h1>이 위치에서는 초기 설정을 할 수 없습니다</h1>
            </div>
            <p className="auth-info">
              이 BuilderGate에는 아직 관리자 비밀번호가 없습니다.
            </p>
            <div className="auth-warning" role="alert">
              <Icon name="alert" />
              <span>처음 비밀번호는 localhost나 허용 목록에 있는 IP에서만 설정할 수 있습니다.</span>
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
