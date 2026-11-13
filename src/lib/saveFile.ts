/** Hands a file to the browser to save, named without the characters file systems refuse. */
export function saveFile(blob: Blob, name: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name.replace(/[\\/:*?"<>|]/g, ' ');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
