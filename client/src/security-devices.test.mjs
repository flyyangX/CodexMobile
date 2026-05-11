import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceCounts, deviceDisplayName, deviceState, sortDevices } from './security-devices.js';

test('deviceState labels current, active, and revoked devices', () => {
  assert.deepEqual(deviceState({ current: true }), { label: '当前设备', className: 'is-current' });
  assert.deepEqual(deviceState({ current: false }), { label: '已授权', className: 'is-active' });
  assert.deepEqual(deviceState({ current: true, revokedAt: '2026-01-01T00:00:00.000Z' }), {
    label: '已撤销',
    className: 'is-revoked'
  });
});

test('sortDevices keeps current first and revoked last', () => {
  const sorted = sortDevices([
    { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'revoked', revokedAt: '2026-01-03T00:00:00.000Z', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'current', current: true, createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'new', createdAt: '2026-01-04T00:00:00.000Z' }
  ]);

  assert.deepEqual(sorted.map((device) => device.id), ['current', 'new', 'old', 'revoked']);
});

test('deviceDisplayName falls back for blank names', () => {
  assert.equal(deviceDisplayName({ name: ' Ray iPhone ' }), 'Ray iPhone');
  assert.equal(deviceDisplayName({ name: '   ' }), '未命名设备');
});

test('deviceCounts separates active and revoked devices', () => {
  assert.deepEqual(deviceCounts([
    { id: 'current', current: true },
    { id: 'active' },
    { id: 'revoked', revokedAt: '2026-01-01T00:00:00.000Z' }
  ]), { active: 2, revoked: 1 });
});
