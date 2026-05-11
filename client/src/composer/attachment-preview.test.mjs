import test from 'node:test';
import assert from 'node:assert/strict';

import { attachmentPreviewUrl, isImageAttachment } from './attachment-preview.js';

test('isImageAttachment recognizes uploaded images by kind or mime type', () => {
  assert.equal(isImageAttachment({ kind: 'image', mimeType: 'application/octet-stream' }), true);
  assert.equal(isImageAttachment({ kind: 'file', mimeType: 'image/png' }), true);
  assert.equal(isImageAttachment({ kind: 'file', mimeType: 'application/pdf' }), false);
});

test('attachmentPreviewUrl points local image paths at the preview endpoint', () => {
  assert.equal(
    attachmentPreviewUrl({ path: '/tmp/uploads/a screenshot.png' }),
    '/api/local-image?path=%2Ftmp%2Fuploads%2Fa%20screenshot.png'
  );
  assert.equal(
    attachmentPreviewUrl({ path: '/tmp/uploads/a.png' }, 'secret token'),
    '/api/local-image?path=%2Ftmp%2Fuploads%2Fa.png'
  );
  assert.equal(attachmentPreviewUrl({ path: '' }), '');
});
