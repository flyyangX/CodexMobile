const SERVICE_TIERS = new Set(['fast', 'flex']);

export function normalizeServiceTier(value) {
  const serviceTier = String(value || '').trim();
  return SERVICE_TIERS.has(serviceTier) ? serviceTier : null;
}
