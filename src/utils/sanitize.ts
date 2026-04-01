/**
 * Sanitization utilities to prevent sensitive data leaks in logs.
 * Recursively masks sensitive fields in objects and arrays.
 */

/** Patterns that indicate sensitive data fields */
const SENSITIVE_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /key/i,
  /password/i,
  /credential/i,
  /auth/i,
  /bearer/i,
  /apikey/i,
  /oauth/i,
  /email/i,
  /phone/i,
];

function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some(pattern => pattern.test(fieldName));
}

/**
 * Sanitizes an object by masking sensitive fields.
 * Recursively processes objects and arrays.
 * Non-sensitive data is preserved for debugging.
 *
 * @param obj Object to sanitize
 * @param depth Current recursion depth (max 10 to prevent infinite loops)
 * @returns Sanitized copy of the object
 */
export function sanitizeSensitiveData(obj: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > 10) return '[max depth reached]';

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Check if the string looks like a token (long base64-like string)
    if (obj.length > 50 && /^[A-Za-z0-9_\-\.]+$/.test(obj)) {
      return `[REDACTED_${obj.slice(0, 4)}...${obj.slice(-4)}]`;
    }
    return obj;
  }

  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeSensitiveData(item, depth + 1));
  }

  // Process object
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveField(key)) {
      // Mask sensitive fields
      if (typeof value === 'string' && value.length > 0) {
        sanitized[key] = `[REDACTED_${value.slice(0, 4)}...${value.slice(-4)}]`;
      } else {
        sanitized[key] = '[REDACTED]';
      }
    } else {
      // Recursively sanitize non-sensitive fields
      sanitized[key] = sanitizeSensitiveData(value, depth + 1);
    }
  }

  return sanitized;
}

/**
 * Masks an API key for safe logging.
 * Shows only first few and last few characters.
 *
 * @param key The API key to mask
 * @returns Masked version like "sk-ant-...abc123"
 */
export function maskApiKeyForLogging(key: string): string {
  if (!key || key.length < 10) return '[invalid key]';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}
