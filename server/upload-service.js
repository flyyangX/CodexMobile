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

function hasImageExtension(value) {
  return /\.(?:png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(String(value || '').split(/[?#]/)[0]);
}

export function classifyUpload(mimeType, fileName = '') {
  return String(mimeType || '').toLowerCase().startsWith('image/') || hasImageExtension(fileName) ? 'image' : 'file';
}

export function sniffMimeType(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const gifHeader = bytes.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return 'image/gif';
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF') {
    return 'application/pdf';
  }
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'video/mp4';
  }
  return '';
}

export function normalizeUploadMimeType(declaredMimeType, data) {
  const declared = String(declaredMimeType || 'application/octet-stream').toLowerCase();
  const sniffed = sniffMimeType(data);
  if (!sniffed || declared === sniffed) {
    return declared;
  }
  return 'application/octet-stream';
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
      const data = buffer.slice(headerEnd + 4, contentEnd);
      return {
        fileName: sanitizeFileName(fileName),
        mimeType: normalizeUploadMimeType(mimeType, data),
        data
      };
    }

    cursor = nextBoundary;
  }

  throw new Error('No file field found');
}

export async function readVoiceUpload(req, {
  maxVoiceBytes = 10 * 1024 * 1024
} = {}) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    const error = new Error('multipart/form-data is required');
    error.statusCode = 400;
    throw error;
  }

  let body;
  try {
    body = await readBuffer(req, maxVoiceBytes);
  } catch (error) {
    const next = new Error(error.message === 'Upload too large' ? '音频超过 10MB' : '读取音频失败');
    next.statusCode = error.message === 'Upload too large' ? 413 : 400;
    throw next;
  }

  let part;
  try {
    part = parseMultipartFile(body, contentType, 'audio');
  } catch {
    const error = new Error('没有收到音频');
    error.statusCode = 400;
    throw error;
  }

  if (!part.data?.length) {
    const error = new Error('没有收到音频');
    error.statusCode = 400;
    throw error;
  }
  if (!String(part.mimeType || '').toLowerCase().startsWith('audio/')) {
    const error = new Error('音频格式不支持');
    error.statusCode = 400;
    throw error;
  }

  return part;
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
    kind: classifyUpload(part.mimeType, part.fileName)
  };
}

export function isPathInsideRoot(filePath, rootPath) {
  if (!filePath || !rootPath) {
    return false;
  }
  const resolvedRoot = path.resolve(rootPath);
  const resolvedFile = path.resolve(filePath);
  const compareRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const compareFile = process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile;
  const relative = path.relative(compareRoot, compareFile);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeAttachments(value, { uploadRoot = '' } = {}) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item.path !== 'string' || !item.path.trim()) {
        return null;
      }
      const attachmentPath = path.resolve(String(item.path));
      if (uploadRoot && !isPathInsideRoot(attachmentPath, uploadRoot)) {
        return null;
      }
      return {
        id: String(item.id || ''),
        name: String(item.name || path.basename(attachmentPath)),
        size: Number(item.size) || 0,
        mimeType: String(item.mimeType || ''),
        path: attachmentPath,
        kind: item.kind === 'image' ? 'image' : classifyUpload(item.mimeType, item.name || attachmentPath)
      };
    })
    .filter(Boolean);
}

export function markdownImageDestination(value) {
  let raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    raw = raw.replace(/\\/g, '/');
  }
  if (/[\s<>()\\]/.test(raw) || /^[A-Za-z]:/.test(raw)) {
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
