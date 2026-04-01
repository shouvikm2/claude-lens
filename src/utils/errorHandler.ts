/**
 * Centralized error handling utilities for consistent error reporting.
 * Provides standardized patterns for logging and handling different error severities.
 */

import { log, logError } from './logger.js';

export type ErrorSeverity = 'critical' | 'warning' | 'info';

/**
 * Handles an error with appropriate logging based on severity.
 *
 * @param err The error that occurred
 * @param context Description of where/why the error occurred
 * @param severity Error severity level (default: 'warning')
 */
export function handleError(
  err: unknown,
  context: string,
  severity: ErrorSeverity = 'warning'
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  if (severity === 'critical') {
    logError(`[CRITICAL] ${context}: ${message}`, stack);
  } else if (severity === 'warning') {
    log(`[WARNING] ${context}: ${message}`);
  } else {
    log(`[INFO] ${context}: ${message}`);
  }
}

/**
 * Wraps a promise-returning function with error handling.
 * Catches errors and logs them without rethrowing.
 * Useful for fire-and-forget async operations.
 *
 * @param fn Async function to execute
 * @param context Description of the operation
 * @param severity Error severity if operation fails (default: 'info')
 * @returns Promise that resolves/rejects based on operation, with error logged
 */
export function silentCatch(
  fn: () => Promise<void>,
  context: string,
  severity: ErrorSeverity = 'info'
): void {
  fn().catch(err => {
    handleError(err, `${context} (silently handled)`, severity);
  });
}

/**
 * Creates a promise with a timeout.
 * Rejects if operation takes longer than the specified duration.
 *
 * @param promise Promise to wait for
 * @param timeoutMs Timeout duration in milliseconds
 * @param timeoutMessage Error message if timeout occurs
 * @returns Promise that rejects on timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Safe JSON parsing with error handling.
 * Returns undefined if parsing fails, optionally logging the error.
 *
 * @param json JSON string to parse
 * @param context Description for error logging
 * @param logError Whether to log parse errors (default: false for sensitive data)
 * @returns Parsed object or undefined
 */
export function safeJsonParse(
  json: string,
  context: string,
  shouldLog: boolean = false
): unknown | undefined {
  try {
    return JSON.parse(json);
  } catch (err) {
    if (shouldLog) {
      log(`[WARNING] Failed to parse JSON (${context}): ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}
