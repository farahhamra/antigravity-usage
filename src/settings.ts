/** Date-only values stay in the user's calendar; never convert them through UTC. */
export function subscriptionDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) return;
  return value;
}
