export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_ALLOWED_SPECIAL_CHARS = '!@#$%^&*()_+=/-';
export const PASSWORD_POLICY_REQUIREMENT_MESSAGE =
  `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters and may only contain English letters, numbers, and ${PASSWORD_ALLOWED_SPECIAL_CHARS}.`;

const PASSWORD_ALLOWED_PATTERN = /^[A-Za-z0-9!@#$%^&*()_+=/-]+$/;

export interface PasswordPolicyResult {
  valid: boolean;
  message?: string;
}

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return { valid: false, message: PASSWORD_POLICY_REQUIREMENT_MESSAGE };
  }

  if (!PASSWORD_ALLOWED_PATTERN.test(password)) {
    return { valid: false, message: PASSWORD_POLICY_REQUIREMENT_MESSAGE };
  }

  return { valid: true };
}
