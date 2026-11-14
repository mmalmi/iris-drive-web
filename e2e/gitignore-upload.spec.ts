import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseNew } from './test-utils';

/** A folder with a .gitignore asks whether to leave out what it ignores. */
test('uploading a folder with a .gitignore can skip the ignored files', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  const project = test.info().outputPath('project');
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), text);
  };
  write('.gitignore', 'node_modules/\n*.log\n');
  write('README.md', 'kept');
  write('src/main.js', 'kept');
  write('error.log', 'ignored');
  write('node_modules/pkg/index.js', 'ignored');

  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Gitignore Test');
  const chooser = page.waitForEvent('filechooser');
  await chooseNew(page, 'Upload folder');
  await (await chooser).setFiles(project);

  await expect(page.getByRole('heading', { name: '.gitignore Detected' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('error.log')).toBeVisible();
  await page.getByRole('button', { name: 'Skip Ignored' }).click();

  const list = page.getByTestId('file-list');
  await list.getByRole('link', { name: 'project', exact: true }).click();
  await expect(list.getByRole('link', { name: /README\.md/ })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole('link', { name: 'src', exact: true })).toBeVisible();
  await expect(list.getByRole('link', { name: /\.gitignore/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /error\.log/ })).toHaveCount(0);
  await expect(list.getByRole('link', { name: 'node_modules' })).toHaveCount(0);
});
