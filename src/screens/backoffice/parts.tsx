/**
 * Presentational pieces shared by the back-office screens: the back link, card panels, status
 * badges, colour swatches, the colour and money fields, and the manager-PIN note.
 */
import { useId, type ReactNode } from 'react';
import { ButtonLink } from '../../components/Button';
import { Banner } from '../../components/Banner';
import { FormField } from '../../components/FormField';
import { readableTextColour, safeColour } from '../../components/colour';
import type { Action } from '../../data/types';
import { can } from '../../rules/permissions';
import { useSession } from '../../store/sessionStore';
import styles from './backoffice.module.css';

/** 'Back office' link for the title row of every back-office section. */
export function BackToMenu() {
  return (
    <ButtonLink to="/backoffice" variant="ghost" className={styles.backLink}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Back office
    </ButtonLink>
  );
}

/**
 * Shown to anyone whose own role can't do `action`: saving will ask for a manager PIN
 * (navigation is never gated, D-070).
 */
export function PermissionNote({ action, children }: { action: Action; children?: ReactNode }) {
  const session = useSession();
  if (session === null || can(session.role, action)) return null;
  return (
    <Banner tone="info" role="none">
      {children ?? 'You can look around here. Saving a change needs a manager PIN.'}
    </Banner>
  );
}

export interface PanelProps {
  title: string;
  /** Heading level (default 2). */
  level?: 2 | 3;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
  /**
   * Takes focus from script (tabindex="-1"): when a focused control inside it goes away, focus
   * moves here rather than to <main> (D-135, D-139).
   */
  focusable?: boolean;
}

/** A white card section (a labelled region) with a heading row. */
export function Panel({ title, level = 2, description, actions, children, className, testId, focusable = false }: PanelProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  const titleId = useId();
  return (
    <section className={`${styles.panel} ${className ?? ''}`} aria-labelledby={titleId} data-testid={testId} tabIndex={focusable ? -1 : undefined}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <Heading id={titleId} className={styles.panelTitle}>
            {title}
          </Heading>
          {description !== undefined && <p className={styles.panelDescription}>{description}</p>}
        </div>
        {actions !== undefined && <div className={styles.panelActions}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

/** A small status pill ('Inactive', 'Low', 'You'). */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`] ?? ''}`}>{children}</span>;
}

/** A colour chip for a category or product button colour (decorative). */
export function Swatch({ colour, size = 'md' }: { colour: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`${styles.swatch} ${styles[`swatch_${size}`] ?? ''}`} style={{ background: safeColour(colour) }} aria-hidden="true" />;
}

export interface ColourFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  /** Text shown on the preview chip (e.g. the product name). */
  previewText?: string;
  /** Second line on the preview chip (e.g. the price). */
  previewDetail?: string;
}

/**
 * '#rrggbb' colour: a hex text box (the labelled control), the browser's colour picker, and a
 * preview in the colour with the text colour the till will use (readableTextColour).
 */
export function ColourField({ label, value, onChange, hint, error, disabled, previewText, previewDetail }: ColourFieldProps) {
  const colour = safeColour(value.trim());
  return (
    <FormField label={label} hint={hint ?? 'A colour like #b45309, or pick one'} error={error}>
      {(control) => (
        <div className={styles.colourRow}>
          <input
            type="color"
            className={styles.colourPicker}
            value={colour.toLowerCase()}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`${label}: pick a colour`}
            disabled={disabled}
          />
          <input
            {...control}
            type="text"
            className={`${styles.input} ${styles.colourText}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            disabled={disabled}
          />
          {previewText !== undefined && (
            <span className={styles.colourPreview} style={{ background: colour, color: readableTextColour(colour) }} aria-hidden="true">
              <span className={styles.colourPreviewName}>{previewText.trim() === '' ? 'Preview' : previewText}</span>
              {previewDetail !== undefined && <span className={`${styles.colourPreviewDetail} tabular`}>{previewDetail}</span>}
            </span>
          )}
        </div>
      )}
    </FormField>
  );
}

export interface AffixFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Text before the input, e.g. '£'. */
  prefix?: string;
  /** Text after the input, e.g. 'minutes' or '%'. */
  suffix?: string;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
}

/** A text input with a fixed prefix/suffix (money, minutes, percentages, quantities). */
export function AffixField({ label, value, onChange, prefix, suffix, hint, error, disabled, inputMode = 'numeric', placeholder, maxLength, autoFocus }: AffixFieldProps) {
  return (
    <FormField label={label} hint={hint} error={error}>
      {(control) => (
        <div className={`${styles.affix} ${error ? styles.affixInvalid : ''} ${disabled === true ? styles.affixDisabled : ''}`}>
          {prefix !== undefined && (
            <span className={styles.affixText} aria-hidden="true">
              {prefix}
            </span>
          )}
          <input
            {...control}
            type="text"
            className={`${styles.affixInput} tabular`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            inputMode={inputMode}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
            autoComplete="off"
            data-autofocus={autoFocus === true ? true : undefined}
          />
          {suffix !== undefined && (
            <span className={styles.affixText} aria-hidden="true">
              {suffix}
            </span>
          )}
        </div>
      )}
    </FormField>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A radio group drawn as large segmented tiles (deal type, adjustment kind). */
export function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  error,
  disabled,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <fieldset className={styles.choiceGroup} disabled={disabled}>
      <legend className={styles.choiceLegend}>{legend}</legend>
      <div className={styles.choiceOptions}>
        {options.map((option) => (
          <label key={option.value} className={`${styles.choice} ${value === option.value ? styles.choiceSelected : ''}`}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className={styles.choiceRadio}
            />
            <span className={styles.choiceText}>
              <span className={styles.choiceLabel}>{option.label}</span>
              {option.hint !== undefined && <span className={styles.choiceHint}>{option.hint}</span>}
            </span>
          </label>
        ))}
      </div>
      {error ? <div className={styles.fieldError}>{error}</div> : null}
    </fieldset>
  );
}

/** A danger banner for a form-level message (inside dialogs and forms). */
export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return <Banner tone="danger">{message}</Banner>;
}
