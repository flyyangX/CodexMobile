function asArray(value) {
  return Array.from(value || []);
}

function isImageFile(file) {
  return Boolean(file && String(file.type || '').startsWith('image/'));
}

export function filesFromClipboardEvent(event) {
  const data = event?.clipboardData;
  if (!data) {
    return [];
  }

  const itemFiles = asArray(data.items)
    .filter((item) => item?.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile?.())
    .filter(isImageFile);

  if (itemFiles.length) {
    return itemFiles;
  }

  return asArray(data.files).filter(isImageFile);
}

export function filesFromDropEvent(event) {
  return asArray(event?.dataTransfer?.files).filter(Boolean);
}

export function dragEventHasFiles(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) {
    return false;
  }
  if (asArray(transfer.files).length > 0) {
    return true;
  }
  return asArray(transfer.types).includes('Files');
}
