/**
 * Gitignore parsing and matching utilities
 * Supports standard .gitignore patterns for filtering directory uploads
 */

export interface GitignorePattern {
  pattern: string;
  regex: RegExp;
  negation: boolean;
  directoryOnly: boolean;
}

/**
 * Parse a .gitignore file content into patterns
 */
export function parseGitignore(content: string): GitignorePattern[] {
  const patterns: GitignorePattern[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    let pattern = trimmed;
    let negation = false;
    let directoryOnly = false;

    // Handle negation
    if (pattern.startsWith('!')) {
      negation = true;
      pattern = pattern.slice(1);
    }

    // Handle directory-only patterns (ending with /)
    if (pattern.endsWith('/')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    const regex = patternToRegex(pattern);

    patterns.push({
      pattern: trimmed,
      regex,
      negation,
      directoryOnly,
    });
  }

  return patterns;
}

function patternToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  const anchored = pattern.startsWith('/');
  if (anchored) {
    pattern = pattern.slice(1);
    regexStr = '^';
  } else {
    regexStr = '(^|/)';
  }

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(.*/)?';
          i += 3;
        } else if (i + 2 === pattern.length) {
          regexStr += '.*';
          i += 2;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
    } else if (char === '[') {
      const closeIdx = pattern.indexOf(']', i + 1);
      if (closeIdx !== -1) {
        regexStr += pattern.slice(i, closeIdx + 1);
        i = closeIdx + 1;
      } else {
        regexStr += '\\[';
        i++;
      }
    } else if (char === '/') {
      regexStr += '/';
      i++;
    } else {
      regexStr += char.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }

  regexStr += '(/.*)?$';

  return new RegExp(regexStr);
}

export function isIgnored(
  path: string,
  isDirectory: boolean,
  patterns: GitignorePattern[],
): boolean {
  const normalizedPath = path.replace(/\\/g, '/');

  let ignored = false;

  for (const { regex, negation, directoryOnly } of patterns) {
    if (directoryOnly && !isDirectory) continue;

    if (regex.test(normalizedPath)) {
      ignored = !negation;
    }
  }

  return ignored;
}

export function filterByGitignore<T extends { relativePath: string }>(
  files: T[],
  patterns: GitignorePattern[],
): { included: T[]; excluded: T[] } {
  const included: T[] = [];
  const excluded: T[] = [];
  const dirIgnoreCache = new Map<string, boolean>();

  for (const file of files) {
    const path = file.relativePath.replace(/\\/g, '/');

    const parts = path.split('/');
    let parentIgnored = false;

    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join('/');

      if (!dirIgnoreCache.has(parentPath)) {
        dirIgnoreCache.set(parentPath, isIgnored(parentPath, true, patterns));
      }

      if (dirIgnoreCache.get(parentPath)) {
        parentIgnored = true;
        break;
      }
    }

    if (parentIgnored || isIgnored(path, false, patterns)) {
      excluded.push(file);
    } else {
      included.push(file);
    }
  }

  return { included, excluded };
}

export const DEFAULT_IGNORE_PATTERNS = parseGitignore(`
# Common OS files
.DS_Store
Thumbs.db
`);
