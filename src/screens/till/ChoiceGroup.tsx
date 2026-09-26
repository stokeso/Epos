import type { ReactNode } from 'react';
import styles from './ChoiceGroup.module.css';

export interface Choice<T extends string> {
  value: T;
  /** Visible label (part of the radio's accessible name). */
  label: ReactNode;
  /** Secondary text at the end of the row (also part of the accessible name). */
  detail?: ReactNode;
}

export interface ChoiceGroupProps<T extends string> {
  /** The group's name (fieldset legend). */
  legend: string;
  hideLegend?: boolean;
  /** Radio group name attribute (unique per form). */
  name: string;
  value: T | null;
  onChange: (value: T) => void;
  options: readonly Choice<T>[];
  /** 'segmented': side-by-side toggle (Name / Table). 'list': one row per option (basket lines). */
  variant?: 'segmented' | 'list';
  disabled?: boolean;
}

/**
 * A single choice from a few options, built on native radio buttons inside a fieldset so it is
 * keyboard and screen-reader friendly (arrow keys move the choice). Each option is at least
 * 48 px tall. e2e: getByRole('radio', { name: 'Table' }).
 */
export function ChoiceGroup<T extends string>({
  legend,
  hideLegend = false,
  name,
  value,
  onChange,
  options,
  variant = 'segmented',
  disabled = false,
}: ChoiceGroupProps<T>) {
  return (
    <fieldset className={`${styles.group} ${styles[variant] ?? ''}`} disabled={disabled}>
      <legend className={hideLegend ? 'visually-hidden' : styles.legend}>{legend}</legend>
      <div className={styles.options}>
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label key={option.value} className={`${styles.option} ${checked ? styles.checked : ''}`}>
              <input
                type="radio"
                className={styles.input}
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
              />
              <span className={styles.mark} aria-hidden="true" />
              <span className={styles.label}>{option.label}</span>
              {option.detail !== undefined && <span className={styles.detail}>{option.detail}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
