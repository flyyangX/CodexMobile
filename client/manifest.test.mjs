import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('manifest prefers fullscreen PWA display with standalone fallback', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));

  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['fullscreen', 'standalone']);
});
