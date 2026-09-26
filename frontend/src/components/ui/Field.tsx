// Form parts (FR-UIDS-002 AC-7): a field frame with its label, help and error,
// and the inputs that sit in it. The label names the unit-less quantity; the
// unit sits beside the value (FR-UIDS-003).
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Icon } from '../common/Icon.tsx';
import { joinClassNames } from './uiClasses.ts';

export interface FieldProps {
  label: ReactNode;
  /** The id of the input the label is for. */
  htmlFor?: string;
  help?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, help, error, className, children }: FieldProps) {
  return (
    <div className={joinClassNames('ui-field', className)}>
      {htmlFor !== undefined
        ? <label className="ui-field-label" htmlFor={htmlFor}>{label}</label>
        : <span className="ui-field-label">{label}</span>}
      {children}
      {error !== undefined && error !== null && error !== false && (
        <span className="ui-field-error" role="alert">
          <Icon name="alert" size={14} />
          {error}
        </span>
      )}
      {help !== undefined && help !== null && help !== false && <span className="ui-field-help">{help}</span>}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export function TextInput({ mono, className, type = 'text', ...rest }: TextInputProps) {
  return <input {...rest} type={type} className={joinClassNames('ui-input', mono && 'ui-input-mono', className)} />;
}

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  unit?: string;
}

export function NumberInput({ unit, className, ...rest }: NumberInputProps) {
  const input = <input {...rest} type="number" className={joinClassNames('ui-input', className)} />;
  if (unit === undefined) return input;
  return (
    <span className="ui-unit-wrap">
      {input}
      <span className="ui-unit" aria-hidden="true">{unit}</span>
    </span>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={joinClassNames('ui-select', className)}>{children}</select>;
}

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children?: ReactNode;
}

export function Switch({ className, children, ...rest }: SwitchProps) {
  return (
    <label className={joinClassNames('ui-switch', className)}>
      <input {...rest} type="checkbox" role="switch" />
      <span className="ui-switch-track" aria-hidden="true" />
      {children}
    </label>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children?: ReactNode;
}

export function Checkbox({ className, children, ...rest }: CheckboxProps) {
  return (
    <label className={joinClassNames('ui-checkbox', className)}>
      <input {...rest} type="checkbox" />
      {children}
    </label>
  );
}
