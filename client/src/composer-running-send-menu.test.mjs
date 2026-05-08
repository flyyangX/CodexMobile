import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('running send menu uses official follow-up language', async () => {
  const app = await fs.readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /<strong>引导<\/strong>/);
  assert.match(app, /<strong>排队<\/strong>/);
  assert.doesNotMatch(app, /<strong>发送到当前任务<\/strong>/);
  assert.doesNotMatch(app, /<strong>加入队列<\/strong>/);
});
