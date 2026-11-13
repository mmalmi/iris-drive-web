/** Text as written in HTML or XML: between tags, or in an attribute in double quotes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** As `escapeHtml`, leaving out the characters XML 1.0 cannot hold at all, which would make the file unreadable. */
export function escapeXml(text: string): string {
  return escapeHtml(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ''));
}
