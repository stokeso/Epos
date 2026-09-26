/** The id CategoryTabs gives a category's tab (use it for the tabpanel's aria-labelledby). */
export function categoryTabId(panelId: string, categoryId: string): string {
  return `${panelId}-tab-${categoryId}`;
}
