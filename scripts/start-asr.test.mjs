import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublishArg } from './start-asr.mjs';

test('buildPublishArg defaults to localhost binding', () => {
  assert.equal(buildPublishArg({ host: '127.0.0.1', port: '8000' }), '127.0.0.1:8000:8000');
});

test('buildPublishArg keeps explicit exposure visible', () => {
  assert.equal(buildPublishArg({ host: '0.0.0.0', port: '9000' }), '0.0.0.0:9000:8000');
});
