/**
 * Format a cost value as a currency string. e.g. 0.123 → "$0.12"
 */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a cost with more precision for small values. e.g. 0.00456 → "$0.005"
 */
export function formatCostPrecise(usd: number): string {
  if (usd === 0) return '$0.000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/**
 * Format a duration in milliseconds to a human-readable string. e.g. 8100000 → "2h 15m"
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Format a percentage as a string. e.g. 0.842 → "84%"
 */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Format a token count with thousands separator. e.g. 9840 → "9,840"
 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/**
 * Format a budget progress bar. e.g. (0.42, 10) → "████░░░░░░"
 */
export function formatProgressBar(ratio: number, width = 10): string {
  const filled = Math.min(Math.round(ratio * width), width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Round hours to nearest 15-minute increment for billing.
 */
export function roundToQuarterHour(ms: number): number {
  const hours = ms / (1000 * 60 * 60);
  return Math.ceil(hours * 4) / 4;
}
