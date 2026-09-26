import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import styles from './FormField.module.css';

/** Props FormField hands to its control so label, hint and error are wired up. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: boolean;
}

export interface FormFieldProps {
  label: string;
  /** Help text under the label (aria-describedby). */
  hint?: ReactNode;
  /** Error message (aria-invalid + aria-describedby); pass AppError.fieldErrors[field]. */
  error?: string | null;
  required?: boolean;
  hideLabel?: boolean;
  /**
   * Announce the error as soon as it appears (role="alert"), for a field whose error arrives
   * while focus is already on it (e.g. Enter in a one-field form, D-134).
   */
  announceError?: boolean;
  /** Render the control with the given props spread on it. */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
  id?: string;
}

/**
 * Label + control + hint + error, accessibly linked. Use TextField / SelectField /
 * CheckboxField / TextAreaField for the common cases, or FormField with a custom control.
 */
export function FormField({ label, hint, error, required = false, hideLabel = false, announceError = false, children, className, id }: FormFieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint !== undefined ? hintId : '', error ? errorId : ''].filter((x) => x !== '').join(' ');
  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      <label htmlFor={controlId} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </label>
      {hint !== undefined && (
        <div id={hintId} className={styles.hint}>
          {hint}
        </div>
      )}
      {children({
        id: controlId,
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(required ? { required: true } : {}),
      })}
      {error ? (
        <div id={errorId} className={styles.error} role={announceError ? 'alert' : undefined}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id' | 'className' | 'children'>;

export interface TextFieldProps extends NativeInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  /** See FormField.announceError. */
  announceError?: boolean;
  className?: string;
  id?: string;
}

/** A labelled text input (type text/password/search/date/number...). */
export function TextField({ label, value, onChange, hint, error, hideLabel, announceError, className, id, required, ...input }: TextFieldProps) {
  return (
    <FormField label={label} hint={hint} error={error} hideLabel={hideLabel} announceError={announceError} className={className} id={id} required={required}>
      {(control) => <input {...input} {...control} className={styles.input} value={value} onChange={(e) => onChange(e.target.value)} />}
    </FormField>
  );
}

type NativeTextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'id' | 'className' | 'children'>;

export interface TextAreaFieldProps extends NativeTextAreaProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  id?: string;
}

export function TextAreaField({ label, value, onChange, hint, error, className, id, required, rows = 3, ...textarea }: TextAreaFieldProps) {
  return (
    <FormField label={label} hint={hint} error={error} className={className} id={id} required={required}>
      {(control) => (
        <textarea {...textarea} {...control} rows={rows} className={`${styles.input} ${styles.textarea}`} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </FormField>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'id' | 'className' | 'children'>;

export interface SelectFieldProps extends NativeSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Adds a first option with value '' (e.g. 'Choose a product'). */
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  id?: string;
}

export function SelectField({ label, value, onChange, options, placeholder, hint, error, className, id, required, ...select }: SelectFieldProps) {
  return (
    <FormField label={label} hint={hint} error={error} className={className} id={id} required={required}>
      {(control) => (
        <select {...select} {...control} className={`${styles.input} ${styles.select}`} value={value} onChange={(e) => onChange(e.target.value)}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

export interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  name?: string;
  className?: string;
  id?: string;
}

/** A large (48 px row) checkbox with its label to the right. */
export function CheckboxField({ label, checked, onChange, hint, error, disabled, name, className, id }: CheckboxFieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint !== undefined ? hintId : '', error ? errorId : ''].filter((x) => x !== '').join(' ');
  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      <label className={styles.checkRow} htmlFor={controlId}>
        <input
          id={controlId}
          type="checkbox"
          className={styles.checkbox}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          name={name}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-invalid={error ? true : undefined}
        />
        <span className={styles.checkLabel}>{label}</span>
      </label>
      {hint !== undefined && (
        <div id={hintId} className={`${styles.hint} ${styles.checkHint}`}>
          {hint}
        </div>
      )}
      {error ? (
        <div id={errorId} className={styles.error}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
