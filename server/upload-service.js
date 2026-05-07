import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBuffer } from './http-utils.js';

export function parseHeaderValue(value, key) {
  const match = String(value || '').match(new RegExp(`${key}="([^"]*)"`));
  return match ? match[1] : '';
}

export function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || 'upload.bin')).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  return baseName || 'upload.bin';
}

export function classifyUpload(mimeType) {
  return String(mimeType || '').startsWith('image/') ? 'image' : 'file';
}

export function parseMultipartFile(buffer, contentType, fieldName = 'file') {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) {
    throw new Error('Missing multipart boundary');
  }
  const acceptedNames = Array.isArray(fieldName) ? fieldName : [fieldName];

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor >= 0) {
    cursor += boundaryBuffer.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) {
      break;
    }
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const nextBoundary = buffer.indexOf(boundaryBuffer, cursor);
    if (nextBoundary < 0) {
      break;
    }

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0 || headerEnd > nextBoundary) {
      cursor = nextBoundary;
      continue;
    }

    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const disposition = headers.match(/^content-disposition:\s*(.+)$/im)?.[1] || '';
    const name = parseHeaderValue(disposition, 'name');
    const fileName = parseHeaderValue(disposition, 'filename');
    const mimeType = headers.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() || 'application/octet-stream';

    if (acceptedNames.includes(name) && fileName) {
      let contentEnd = nextBoundary;
      if (buffer[contentEnd - 2] === 13 && buffer[contentEnd - 1] === 10) {
        contentEnd -= 2;
      }
      return {
        fileName: sanitizeFileName(fileName),
        mimeType,
        data: buffer.slice(headerEnd + 4, contentEnd)
      };
    }

    cursor = nextBoundary;
  }

  throw new Error('No file field found');
}

export async function saveUpload(req, {
  uploadRoot,
  maxUploadBytes = 50 * 1024 * 1024
} = {}) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('multipart/form-data is required');
  }

  const body = await readBuffer(req, maxUploadBytes);
  const part = parseMultipartFile(body, contentType);
  const id = crypto.randomUUID();
  const dateFolder = new Date().toISOString().slice(0, 10);
  const filePath = path.join(uploadRoot, dateFolder, `${id}-${part.fileName}`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, part.data);

  return {
    id,
    name: part.fileName,
    size: part.data.length,
    mimeType: part.mimeType,
    path: filePath,
    kind: classifyUpload(part.mimeType)
  };
}

export function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item.path === 'string' && item.path.trim())
    .map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || path.basename(item.path)),
      size: Number(item.size) || 0,
      mimeType: String(item.mimeType || ''),
      path: String(item.path),
      kind: item.kind === 'image' ? 'image' : 'file'
    }));
}

export function markdownImageDestination(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/[\s<>()]/.test(raw)) {
    return `<${raw.replace(/>/g, '%3E')}>`;
  }
  return raw;
}

export function markdownImageAlt(value) {
  return String(value || '图片').replace(/[\[\]\n\r]/g, '').trim() || '图片';
}

export function imageAttachmentMarkdown(attachment) {
  const destination = markdownImageDestination(attachment.path);
  if (!destination) {
    return '';
  }
  return `![${markdownImageAlt(attachment.name)}](${destination})`;
}

export function withImageAttachmentPreviews(message, attachments) {
  const imageLines = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map(imageAttachmentMarkdown)
    .filter(Boolean);
  return [message, imageLines.join('\n')].filter(Boolean).join('\n\n');
}

export function withAttachmentReferences(message, attachments) {
  if (!attachments.length) {
    return message;
  }

  const fileLines = attachments.filter((attachment) => attachment.kind !== 'image').map((attachment) => {
    const type = attachment.kind === 'image' ? '图片' : '文件';
    return `- ${type}: ${attachment.name} (${attachment.path})`;
  });
  if (!fileLines.length) {
    return message;
  }
  return [message, `附件路径:\n${fileLines.join('\n')}`].filter(Boolean).join('\n\n');
}

export function normalizeFileMentions(value) {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();
  const mentions = [];
  for (const item of items) {
    const pathValue = String(item?.path || '').trim();
    if (!pathValue || seen.has(pathValue)) {
      continue;
    }
    seen.add(pathValue);
    const name = String(item?.name || item?.fileName || path.basename(pathValue)).trim() || path.basename(pathValue);
    mentions.push({ name, path: pathValue });
    if (mentions.length >= 12) {
      break;
    }
  }
  return mentions;
}

export function withFileMentionReferences(message, fileMentions = []) {
  const mentions = normalizeFileMentions(fileMentions);
  if (!mentions.length) {
    return message;
  }
  const lines = mentions.map((mention) => `- 文件: ${mention.name} (${mention.path})`);
  return [message, `引用文件路径:\n${lines.join('\n')}`].filter(Boolean).join('\n\n');
}
