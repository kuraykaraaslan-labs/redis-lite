/** Helpers shared by the server command suites. */

/** Returns the error message a promise rejects with. */
export async function errOf(p: Promise<unknown>): Promise<string> {
  let res: unknown;
  try {
    res = await p;
  } catch (e) {
    return (e as Error).message;
  }
  return `<no error, got ${JSON.stringify(res)}>`;
}

/** Resolves to the reply, or to the error message if the command fails. */
export function errOrValue(p: Promise<unknown>): Promise<unknown> {
  return p.catch((e: Error) => e.message);
}

/** Converts a flat [k, v, k, v] RESP2 array into an object. */
export function pairs(arr: unknown): Record<string, unknown> {
  const a = arr as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < a.length; i += 2) out[String(a[i])] = a[i + 1];
  return out;
}
