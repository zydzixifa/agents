/**
 * Shared market-data filtering utilities.
 *
 * These helpers validate and filter data. They do not fetch data,
 * access credentials, or execute trades.
 */

export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeTimeframe(value: string): string {
  return value.trim().toUpperCase();
}

export function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error("Value must be a safe integer.");
  }

  if (value < minimum || value > maximum) {
    throw new Error(
      `Value must be between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

export function compactText(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  if (maxLength <= 3) {
    return cleaned.slice(0, maxLength);
  }

  return `${cleaned.slice(0, maxLength - 3)}...`;
}

export function filterBySymbol<T extends { symbol?: unknown }>(
  items: T[],
  requestedSymbol: string,
): T[] {
  const target = normalizeSymbol(requestedSymbol);

  return items.filter(
    (item) =>
      typeof item.symbol === "string" &&
      normalizeSymbol(item.symbol) === target,
  );
}

export function filterByTimeframe<
  T extends { timeframe?: unknown },
>(
  items: T[],
  requestedTimeframe: string,
): T[] {
  const target = normalizeTimeframe(requestedTimeframe);

  return items.filter(
    (item) =>
      typeof item.timeframe === "string" &&
      normalizeTimeframe(item.timeframe) === target,
  );
}
