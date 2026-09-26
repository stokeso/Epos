import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { buttonClassName, type ButtonStyleOptions } from './buttonClassName';
import styles from './Button.module.css';

export type { ButtonSize, ButtonStyleOptions, ButtonVariant } from './buttonClassName';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>, ButtonStyleOptions {
  /**
   * Shows a spinner, sets aria-busy and makes the button unavailable (aria-disabled; clicks and
   * form submits are ignored). It is not natively disabled while busy, so a button that has
   * keyboard focus keeps it instead of dropping focus to <body> (D-134).
   */
  busy?: boolean;
  /** Visible content (the accessible name unless aria-label is given). */
  children?: ReactNode;
}

/**
 * The standard button: a real <button> with a 48 px minimum touch target.
 * type defaults to 'button' (never submits a form by accident).
 * `aria-disabled` (or `busy`) makes it unavailable but still focusable: its clicks are ignored.
 */
export function Button({ variant, size, block, className, busy = false, disabled, type = 'button', children, onClick, ...rest }: ButtonProps) {
  const unavailable = busy || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <button
      {...rest}
      type={type}
      className={buttonClassName({ variant, size, block, className: `${busy ? styles.busy : ''} ${className ?? ''}` })}
      disabled={disabled === true && !busy}
      aria-disabled={unavailable || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        // preventDefault also stops a submit button's form submission (including Enter in a field).
        if (unavailable) event.preventDefault();
        else onClick?.(event);
      }}
    >
      {busy && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends LinkProps, ButtonStyleOptions {}

/** A router link styled as a button (navigation, never gated: D-070). */
export function ButtonLink({ variant, size, block, className, ...rest }: ButtonLinkProps) {
  return <Link {...rest} className={buttonClassName({ variant, size, block, className })} />;
}
