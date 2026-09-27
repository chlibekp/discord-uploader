export interface FilterableRecord {
  name: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}
export function matchesFilter(name: string, query: string): boolean;
export function filterRecords<T extends { name: string }>(
  records: T[],
  query: string,
): T[];
export const SORT_MODES: string[];
export function sortRecords<T extends FilterableRecord>(
  records: T[],
  mode: string,
): T[];
export function formatRemaining(expiresAt: number, now?: number): string;
