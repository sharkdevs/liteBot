// The latest moment a JavaScript Date can represent, in whole seconds since the Unix epoch.
// Source: https://tc39.es/ecma262/#sec-time-values-and-time-range
const MAX_UNIX_SECONDS = 8_640_000_000_000;

/** `true` for a string of digits that names a second a `Date` can represent. */
export function isUnixSecondsString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && Number(value) <= MAX_UNIX_SECONDS;
}

/** Converts a string accepted by {@link isUnixSecondsString} to a `Date`. */
export function unixSecondsToDate(seconds: string): Date {
  return new Date(Number(seconds) * 1000);
}
