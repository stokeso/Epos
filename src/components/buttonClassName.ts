import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerOutline' | 'ghost' | 'onBrand';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
}

/** Class names for anything that should look like a Button (e.g. a router Link). */
export function buttonClassName({ variant = 'secondary', size = 'md', block = false, className }: ButtonStyleOptions = {}): string {
  return [styles.button, styles[variant], size === 'md' ? '' : styles[size], block ? styles.block : '', className ?? '']
    .filter((c) => c !== '' && c !== undefined)
    .join(' ');
}
