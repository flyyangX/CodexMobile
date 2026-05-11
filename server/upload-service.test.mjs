import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  classifyUpload,
  isPathInsideRoot,
  normalizeFileMentions,
  normalizeAttachments,
  parseMultipartFile,
  withAttachmentReferences,
  withFileMentionReferences,
  withImageAttachmentPreviews
} from './upload-service.js';

function multipartBody({ boundary, fieldName = 'file', fileName, mimeType, data }) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`),
    Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

test('parseMultipartFile extracts and sanitizes an uploaded file', () => {
  const boundary = 'codexmobile-test-boundary';
  const body = multipartBody({
    boundary,
    fileName: '../bad:name.txt',
    mimeType: 'text/plain',
    data: 'hello'
  });

  const file = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);

  assert.equal(file.fileName, 'bad_name.txt');
  assert.equal(file.mimeType, 'text/plain');
  assert.equal(file.data.toString('utf8'), 'hello');
});

test('parseMultipartFile downgrades mismatched file mime type', () => {
  const boundary = 'codex-boundary';
  const body = multipartBody({
    boundary,
    fileName: 'fake.png',
    mimeType: 'image/png',
    data: '%PDF-1.7\n'
  });

  const file = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);

  assert.equal(file.mimeType, 'application/octet-stream');
});

test('classifyUpload treats image extensions as images when mobile browsers omit image MIME', () => {
  assert.equal(classifyUpload('application/octet-stream', 'photo.PNG'), 'image');
  assert.equal(classifyUpload('', 'scan.jpeg'), 'image');
  assert.equal(classifyUpload('application/pdf', 'brief.pdf'), 'file');
});

test('normalizeAttachments recovers image kind from MIME or file extension', () => {
  const uploadRoot = path.resolve('/tmp/codexmobile/uploads');
  const pngPath = path.join(uploadRoot, '2026-05-10', 'photo.png');
  const heicPath = path.join(uploadRoot, '2026-05-10', 'photo.heic');
  const attachments = normalizeAttachments([
    { name: 'photo.png', path: pngPath, kind: 'file', mimeType: 'application/octet-stream' },
    { name: 'photo.heic', path: heicPath, kind: 'file', mimeType: 'image/heic' }
  ], { uploadRoot });

  assert.deepEqual(attachments.map((attachment) => attachment.kind), ['image', 'image']);
});

test('normalizeAttachments keeps valid paths and splits image/file references', () => {
  const imagePath = path.resolve('/tmp/a image.png');
  const filePath = path.resolve('/tmp/brief.pdf');
  const attachments = normalizeAttachments([
    { id: 1, name: '图[片].png', path: imagePath, kind: 'image', mimeType: 'image/png' },
    { name: 'brief.pdf', path: filePath, kind: 'file', mimeType: 'application/pdf' },
    { name: 'missing-path' }
  ]);

  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].kind, 'image');
  assert.equal(attachments[1].kind, 'file');
  assert.equal(
    withImageAttachmentPreviews('看图', attachments),
    `看图\n\n![图片.png](<${imagePath.replace(/\\/g, '/')}>)`
  );
  assert.equal(
    withAttachmentReferences('看文件', attachments),
    `看文件\n\n附件路径:\n- 文件: brief.pdf (${filePath})`
  );
});

test('normalizeAttachments drops client supplied paths outside the upload root', () => {
  const uploadRoot = path.resolve('/tmp/codexmobile/uploads');
  const inside = path.join(uploadRoot, '2026-05-10', 'image.png');
  const attachments = normalizeAttachments([
    { name: 'image.png', path: inside, kind: 'image', mimeType: 'image/png' },
    { name: 'secret.txt', path: path.resolve('/tmp/secret.txt'), kind: 'file' }
  ], { uploadRoot });

  assert.equal(isPathInsideRoot(inside, uploadRoot), true);
  assert.equal(isPathInsideRoot(path.resolve('/tmp/secret.txt'), uploadRoot), false);
  assert.deepEqual(attachments.map((attachment) => attachment.name), ['image.png']);
});

test('file mention references dedupe paths and append to the model message', () => {
  const mentions = normalizeFileMentions([
    { name: 'App.jsx', path: '/repo/client/src/App.jsx' },
    { name: 'duplicate.jsx', path: '/repo/client/src/App.jsx' },
    { path: '/repo/server/index.js' },
    { name: 'missing-path' }
  ]);

  assert.deepEqual(mentions, [
    { name: 'App.jsx', path: '/repo/client/src/App.jsx' },
    { name: 'index.js', path: '/repo/server/index.js' }
  ]);
  assert.equal(
    withFileMentionReferences('看这两个文件', mentions),
    '看这两个文件\n\n引用文件路径:\n- 文件: App.jsx (/repo/client/src/App.jsx)\n- 文件: index.js (/repo/server/index.js)'
  );
});
