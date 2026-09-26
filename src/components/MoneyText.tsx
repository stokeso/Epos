import { formatPence, negate } from '../rules/money';
import styles from './MoneyText.module.css';

export interface MoneyTextProps {
  /** Integer pence. */
  pence: number;
  /**
   * The value is a stored positive amount shown as a subtraction (deal saving, member discount,
   * deposit applied): prints formatPence(negate(pence)), e.g. 173 -> '-£1.73' (D-005).
   */
  asDeduction?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  strong?: boolean;
  /** 'muted' for secondary amounts. Deductions are tinted automatically. */
  tone?: 'default' | 'muted';
  className?: string;
  testId?: string;
  id?: string;
}

const SIZE_CLASS = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
  xl: styles.xl,
  '2xl': styles.xxl,
  '3xl': styles.xxxl,
} as const;

/** Money for display: formatPence (D-005) with tabular numerals. */
export function MoneyText({ pence, asDeduction = false, size = 'md', strong = false, tone = 'default', className, testId, id }: MoneyTextProps) {
  const text = formatPence(asDeduction ? negate(pence) : pence);
  const classes = [
    'money',
    styles.money,
    SIZE_CLASS[size],
    strong ? styles.strong : '',
    asDeduction && pence !== 0 ? styles.deduction : '',
    tone === 'muted' ? styles.muted : '',
    className ?? '',
  ]
    .filter((c) => c !== '' && c !== undefined)
    .join(' ');
  return (
    <span className={classes} data-testid={testId} id={id}>
      {text}
    </span>
  );
}
