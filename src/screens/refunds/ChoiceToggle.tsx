import styles from './ChoiceToggle.module.css';

export interface ToggleOption<T extends string> {
  value: T;
  label: string;
}

export interface ChoiceToggleProps<T extends string> {
  /** The group's accessible name (fieldset legend). */
  legend: string;
  hideLegend?: boolean;
  /** Radio group name attribute: unique on the screen. */
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly ToggleOption<T>[];
  disabled?: boolean;
  size?: 'md' | 'lg';
  testId?: string;
}

/**
 * Two or three options side by side (Cash / Card, Return to stock / Waste), built on native radio
 * buttons inside a fieldset so arrow keys and screen readers work. Each option is at least 48 px
 * tall. e2e: getByRole('group', { name: legend }).getByRole('radio', { name: 'Waste' }).
 */
export function ChoiceToggle<T extends string>({
  legend,
  hideLegend = false,
  name,
  value,
  onChange,
  options,
  disabled = false,
  size = 'md',
  testId,
}: ChoiceToggleProps<T>) {
  return (
    <fieldset className={`${styles.group} ${size === 'lg' ? styles.lg : ''}`} disabled={disabled} data-testid={testId}>
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
              <span className={styles.label}>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
