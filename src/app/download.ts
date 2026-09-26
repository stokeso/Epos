/**
 * Saving a file from the browser (backup export, D-091): a Blob and an <a download> click.
 * The app can't tell whether the user cancelled the save and doesn't try.
 */

/** Downloads `text` as `fileName` (default type application/json). */
export function downloadTextFile(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
