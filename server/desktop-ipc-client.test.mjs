/**
 * 测试 server/desktop-ipc-client.js：IPC socket、方法版本与探测行为。
 *
 * Keywords: desktop-ipc, test, unix-socket
 *
 * Exports: 无导出，内含用例
 *
 * Inward: desktop-ipc-client.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as desktopIpc from './desktop-ipc-client.js';

const { DesktopIpcClient, desktopIpcMethodVersion } = desktopIpc;

test('desktop mirror IPC methods use the current desktop protocol version', () => {
  assert.equal(desktopIpcMethodVersion('initialize'), 0);
  assert.equal(desktopIpcMethodVersion('thread-archived'), 2);
  assert.equal(desktopIpcMethodVersion('thread-unarchived'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-compact-thread'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-set-model-and-reasoning'), 1);
  assert.equal(desktopIpcMethodVersion('thread-stream-state-changed'), 6);
  assert.equal(desktopIpcMethodVersion('thread-follower-start-turn'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-steer-turn'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-interrupt-turn'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-set-collaboration-mode'), 1);
});

function frameFor(payload) {
  const json = JSON.stringify(payload);
  const frame = Buffer.alloc(4 + Buffer.byteLength(json));
  frame.writeUInt32LE(Buffer.byteLength(json), 0);
  frame.write(json, 4);
  return frame;
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected = null;
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected == null && buffer.length >= 4) {
        expected = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }
      if (expected != null && buffer.length >= expected) {
        socket.off('data', onData);
        resolve(JSON.parse(buffer.subarray(0, expected).toString('utf8')));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function readFrames(socket, count) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected = null;
    const frames = [];
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (expected == null) {
          if (buffer.length < 4) {
            return;
          }
          expected = buffer.readUInt32LE(0);
          buffer = buffer.subarray(4);
        }
        if (buffer.length < expected) {
          return;
        }
        frames.push(JSON.parse(buffer.subarray(0, expected).toString('utf8')));
        buffer = buffer.subarray(expected);
        expected = null;
        if (frames.length >= count) {
          socket.off('data', onData);
          resolve(frames);
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

test('compactDesktopFollowerThread requests desktop context compaction', async () => {
  assert.equal(typeof desktopIpc.compactDesktopFollowerThread, 'function');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const sent = desktopIpc.compactDesktopFollowerThread('thread-1', {
    socketPath,
    timeoutMs: 1000
  });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  const request = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: request.requestId,
    resultType: 'success',
    method: 'thread-follower-compact-thread',
    result: { compacted: true }
  }));
  const result = await sent;

  assert.deepEqual(result, { compacted: true });
  assert.equal(request.type, 'request');
  assert.equal(request.method, 'thread-follower-compact-thread');
  assert.equal(request.version, 1);
  assert.deepEqual(request.params, { conversationId: 'thread-1' });

  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('startDesktopFollowerTurn requests desktop turn start with turn params', async () => {
  assert.equal(typeof desktopIpc.startDesktopFollowerTurn, 'function');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const turnStartParams = {
    input: [{ type: 'text', text: '从手机发到桌面', text_elements: [] }],
    cwd: '/tmp/project',
    model: 'gpt-5.5',
    effort: 'high'
  };
  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const sent = desktopIpc.startDesktopFollowerTurn('thread-1', turnStartParams, {
    socketPath,
    timeoutMs: 1000
  });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  const request = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: request.requestId,
    resultType: 'success',
    method: 'thread-follower-start-turn',
    result: { turn: { id: 'desktop-turn-1' } }
  }));
  const result = await sent;

  assert.deepEqual(result, { turn: { id: 'desktop-turn-1' } });
  assert.equal(request.type, 'request');
  assert.equal(request.method, 'thread-follower-start-turn');
  assert.equal(request.version, 1);
  assert.deepEqual(request.params, {
    conversationId: 'thread-1',
    turnStartParams
  });

  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('sendBroadcast writes desktop IPC broadcast frames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const client = new DesktopIpcClient({ clientType: 'codexmobile-test', socketPath });
  const connected = client.connect({ timeoutMs: 1000 });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  await connected;

  client.sendBroadcast('thread-archived', {
    hostId: 'local',
    conversationId: 'thread-1',
    cwd: null
  });
  const broadcast = await readFrame(socket);

  assert.equal(broadcast.type, 'broadcast');
  assert.equal(broadcast.method, 'thread-archived');
  assert.equal(broadcast.sourceClientId, 'client-1');
  assert.equal(broadcast.version, 2);
  assert.deepEqual(broadcast.params, {
    hostId: 'local',
    conversationId: 'thread-1',
    cwd: null
  });

  client.close();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('broadcastDesktopThreadUnarchived writes desktop unarchive broadcast frames', async () => {
  assert.equal(typeof desktopIpc.broadcastDesktopThreadUnarchived, 'function');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const sent = desktopIpc.broadcastDesktopThreadUnarchived('thread-1', {
    hostId: 'local',
    cwd: '/repo',
    socketPath,
    timeoutMs: 1000
  });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  const broadcast = await readFrame(socket);
  const result = await sent;

  assert.deepEqual(result, { sent: true });
  assert.equal(broadcast.type, 'broadcast');
  assert.equal(broadcast.method, 'thread-unarchived');
  assert.equal(broadcast.sourceClientId, 'client-1');
  assert.equal(broadcast.version, 1);
  assert.deepEqual(broadcast.params, {
    hostId: 'local',
    conversationId: 'thread-1',
    cwd: '/repo'
  });

  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('broadcastDesktopThreadTitleUpdated writes desktop title update broadcast frames', async () => {
  assert.equal(typeof desktopIpc.broadcastDesktopThreadTitleUpdated, 'function');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const sent = desktopIpc.broadcastDesktopThreadTitleUpdated('thread-1', 'Renamed thread', {
    hostId: 'local',
    socketPath,
    timeoutMs: 1000
  });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  const broadcast = await readFrame(socket);
  const result = await sent;

  assert.deepEqual(result, { sent: true });
  assert.equal(broadcast.type, 'broadcast');
  assert.equal(broadcast.method, 'thread-title-updated');
  assert.equal(broadcast.sourceClientId, 'client-1');
  assert.equal(broadcast.version, 0);
  assert.deepEqual(broadcast.params, {
    hostId: 'local',
    conversationId: 'thread-1',
    title: 'Renamed thread'
  });

  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('broadcastDesktopThreadListRefresh invalidates desktop task and command search queries', async () => {
  assert.equal(typeof desktopIpc.broadcastDesktopThreadListRefresh, 'function');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const sent = desktopIpc.broadcastDesktopThreadListRefresh({
    hostId: 'local',
    conversationId: 'thread-1',
    cwd: '/repo',
    reason: 'background-thread-created',
    socketPath,
    timeoutMs: 1000
  });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  const [taskBroadcast, searchBroadcast] = await readFrames(socket, 2);
  const result = await sent;

  assert.equal(result.sent, true);
  assert.equal(taskBroadcast.type, 'broadcast');
  assert.equal(taskBroadcast.method, 'query-cache-invalidate');
  assert.equal(taskBroadcast.sourceClientId, 'client-1');
  assert.equal(taskBroadcast.version, 0);
  assert.deepEqual(taskBroadcast.params, { queryKey: ['tasks'] });
  assert.equal(searchBroadcast.method, 'query-cache-invalidate');
  assert.deepEqual(searchBroadcast.params, { queryKey: ['command-menu-thread-search', 'local'] });

  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});
