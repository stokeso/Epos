import { useRef, type KeyboardEvent } from 'react';
import type { Category } from '../data/types';
import { categoryTabId } from './categoryTabId';
import { safeColour } from './colour';
import styles from './CategoryTabs.module.css';

export interface CategoryTabsProps {
  categories: readonly Pick<Category, 'id' | 'name' | 'colour'>[];
  selectedId: string | null;
  onSelect: (categoryId: string) => void;
  /** id of the element with role="tabpanel" that shows the selected category's products. */
  panelId: string;
  /** Accessible name of the tab list. Default 'Categories'. */
  label?: string;
}

/**
 * Category tabs across the top of the till (spec §6.3): a WAI-ARIA tablist with roving focus
 * (Left/Right/Home/End select). It scrolls sideways inside itself on narrow screens, so the page
 * never scrolls horizontally. e2e: getByRole('tab', { name: 'Draught' }).
 */
export function CategoryTabs({ categories, selectedId, onSelect, panelId, label = 'Categories' }: CategoryTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    categories.findIndex((c) => c.id === selectedId),
  );

  const move = (index: number): void => {
    const category = categories[index];
    if (category === undefined) return;
    onSelect(category.id);
    const tab = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(categoryTabId(panelId, category.id))}`);
    tab?.focus();
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = categories.length - 1;
    if (event.key === 'ArrowRight') move(selectedIndex >= last ? 0 : selectedIndex + 1);
    else if (event.key === 'ArrowLeft') move(selectedIndex <= 0 ? last : selectedIndex - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(last);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
      {categories.map((category, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={category.id}
            id={categoryTabId(panelId, category.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            style={{ ['--tab-colour' as string]: safeColour(category.colour) }}
            onClick={() => onSelect(category.id)}
          >
            <span className={styles.swatch} aria-hidden="true" />
            {category.name}
          </button>
        );
      })}
    </div>
  );
}
