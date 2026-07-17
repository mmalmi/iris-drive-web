import { execFileSync } from 'node:child_process';

const command = process.env.HTREE_BIN || 'htree';
const version = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();

if (version !== 'htree 0.2.99') {
  throw new Error(`Iris Drive publication requires htree 0.2.99, found ${version || 'no version'}`);
}

console.log('Verified public htree 0.2.99 publisher');
