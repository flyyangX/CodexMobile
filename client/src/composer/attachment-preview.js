export function isImageAttachment(attachment = {}) {
  const mimeType = String(attachment.mimeType || '').toLowerCase();
  return attachment.kind === 'image' || mimeType.startsWith('image/');
}

export function attachmentPreviewUrl(attachment = {}) {
  const imagePath = String(attachment.path || '').trim();
  if (!imagePath) {
    return '';
  }
  return `/api/local-image?path=${encodeURIComponent(imagePath)}`;
}
