import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('model menu opens on intelligence choices and keeps model and speed in secondary panels', async () => {
  const app = await fs.readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /const \[modelMenuPanel, setModelMenuPanel\] = useState\('root'\)/);
  assert.match(app, /modelMenuPanel === 'root'/);
  assert.match(app, /setModelMenuPanel\('model'\)/);
  assert.match(app, /setModelMenuPanel\('speed'\)/);

  const rootStart = app.indexOf("modelMenuPanel === 'root'");
  const modelStart = app.indexOf("modelMenuPanel === 'model'");
  assert.notEqual(rootStart, -1);
  assert.notEqual(modelStart, -1);
  const rootPanel = app.slice(rootStart, modelStart);

  assert.match(rootPanel, /REASONING_OPTIONS\.map/);
  assert.doesNotMatch(rootPanel, /modelList\.map/);
  assert.doesNotMatch(rootPanel, /MODEL_SPEED_OPTIONS\.map/);
});
