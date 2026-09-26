import type { ReactNode } from 'react';
import styles from './DataTable.module.css';

export interface DataTableColumn<T> {
  /** Unique column key (also used by `footer`). */
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** 'end' right-aligns (money, counts). numeric implies 'end' and tabular numerals. */
  align?: 'start' | 'center' | 'end';
  numeric?: boolean;
  /** Render this column's cells as row headers (<th scope="row">). */
  rowHeader?: boolean;
  /** CSS width, e.g. '30%' or '8rem'. */
  width?: string;
}

export interface DataTableProps<T> {
  /** The table's accessible name (<caption>). */
  caption: string;
  hideCaption?: boolean;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string;
  /** Shown in a single row when `rows` is empty. Default 'Nothing to show'. */
  emptyMessage?: string;
  /** Totals row keyed by column key. */
  footer?: Readonly<Record<string, ReactNode>>;
  /** Extra class for a row (e.g. highlight inactive items). */
  rowClassName?: (row: T) => string | undefined;
  testId?: string;
  dense?: boolean;
  /** Extra class on the scrolling region (e.g. a screen's phone-only compact style). */
  className?: string;
}

/**
 * A semantic table for lists and reports. On narrow screens it scrolls sideways inside its own
 * focusable region, so the page itself never scrolls horizontally; an edge shadow shows while
 * there is more to scroll to.
 */
export function DataTable<T>({
  caption,
  hideCaption = false,
  columns,
  rows,
  getRowKey,
  emptyMessage = 'Nothing to show',
  footer,
  rowClassName,
  testId,
  dense = false,
  className,
}: DataTableProps<T>) {
  const alignClass = (column: DataTableColumn<T>): string => {
    const align = column.align ?? (column.numeric === true ? 'end' : 'start');
    return `${styles[align] ?? ''} ${column.numeric === true ? 'tabular' : ''}`;
  };
  return (
    <div className={`${styles.scroller} ${className ?? ''}`} role="region" aria-label={caption} tabIndex={0} data-testid={testId}>
      <table className={`${styles.table} ${dense ? styles.dense : ''}`}>
        <caption className={hideCaption ? 'visually-hidden' : styles.caption}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={alignClass(column)} style={column.width === undefined ? undefined : { width: column.width }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowKey(row)} className={rowClassName?.(row)}>
                {columns.map((column) =>
                  column.rowHeader === true ? (
                    <th key={column.key} scope="row" className={alignClass(column)}>
                      {column.render(row)}
                    </th>
                  ) : (
                    <td key={column.key} className={alignClass(column)}>
                      {column.render(row)}
                    </td>
                  ),
                )}
              </tr>
            ))
          )}
        </tbody>
        {footer !== undefined && rows.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((column) => (
                <td key={column.key} className={alignClass(column)}>
                  {footer[column.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
