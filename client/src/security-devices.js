export function deviceState(device) {
  if (device?.revokedAt) {
    return { label: '已撤销', className: 'is-revoked' };
  }
  if (device?.current) {
    return { label: '当前设备', className: 'is-current' };
  }
  return { label: '已授权', className: 'is-active' };
}

export function sortDevices(devices) {
  return [...(Array.isArray(devices) ? devices : [])].sort((left, right) => {
    const leftRank = left?.revokedAt ? 2 : left?.current ? 0 : 1;
    const rightRank = right?.revokedAt ? 2 : right?.current ? 0 : 1;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return String(right?.lastSeenAt || right?.createdAt || '').localeCompare(String(left?.lastSeenAt || left?.createdAt || ''));
  });
}

export function deviceDisplayName(device) {
  return String(device?.name || '').trim() || '未命名设备';
}

export function deviceCounts(devices) {
  const values = Array.isArray(devices) ? devices : [];
  return {
    active: values.filter((device) => !device?.revokedAt).length,
    revoked: values.filter((device) => device?.revokedAt).length
  };
}
