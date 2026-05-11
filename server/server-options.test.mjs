import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHttpListenHost } from './server-options.js';

test('resolveHttpListenHost keeps public HTTP local after HTTPS starts', () => {
  assert.equal(
    resolveHttpListenHost({ publicAccess: true, httpsStarted: true, host: '0.0.0.0' }),
    '127.0.0.1'
  );
});

test('resolveHttpListenHost keeps configured host when HTTPS did not start', () => {
  assert.equal(
    resolveHttpListenHost({ publicAccess: true, httpsStarted: false, host: '0.0.0.0' }),
    '0.0.0.0'
  );
});

test('resolveHttpListenHost keeps configured host outside public access mode', () => {
  assert.equal(
    resolveHttpListenHost({ publicAccess: false, httpsStarted: true, host: '0.0.0.0' }),
    '0.0.0.0'
  );
});
