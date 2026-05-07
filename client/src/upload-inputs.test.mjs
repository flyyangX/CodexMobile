import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dragEventHasFiles,
  filesFromClipboardEvent,
  filesFromDropEvent
} from './upload-inputs.js';

function fakeFile(name, type) {
  return { name, type, size: 1234 };
}

function fakeClipboardItem(file) {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => file
  };
}

test('filesFromClipboardEvent extracts only pasted image files', () => {
  const image = fakeFile('plot.png', 'image/png');
  const textFile = fakeFile('notes.txt', 'text/plain');
  const event = {
    clipboardData: {
      items: [
        fakeClipboardItem(image),
        fakeClipboardItem(textFile),
        { kind: 'string', type: 'text/plain', getAsFile: () => null }
      ],
      files: []
    }
  };

  assert.deepEqual(filesFromClipboardEvent(event), [image]);
});

test('filesFromClipboardEvent ignores plain text paste', () => {
  const event = {
    clipboardData: {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: []
    }
  };

  assert.deepEqual(filesFromClipboardEvent(event), []);
});

test('filesFromClipboardEvent falls back to clipboardData.files for images', () => {
  const image = fakeFile('clipboard.jpg', 'image/jpeg');
  const event = {
    clipboardData: {
      items: [],
      files: [image, fakeFile('document.pdf', 'application/pdf')]
    }
  };

  assert.deepEqual(filesFromClipboardEvent(event), [image]);
});

test('filesFromDropEvent returns all dropped files', () => {
  const image = fakeFile('screen.png', 'image/png');
  const sheet = fakeFile('table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const event = {
    dataTransfer: {
      files: [image, sheet]
    }
  };

  assert.deepEqual(filesFromDropEvent(event), [image, sheet]);
});

test('dragEventHasFiles detects drag payloads that include files', () => {
  assert.equal(dragEventHasFiles({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(dragEventHasFiles({ dataTransfer: { types: ['Files'] } }), true);
  assert.equal(dragEventHasFiles({ dataTransfer: { files: [fakeFile('a.png', 'image/png')] } }), true);
});
