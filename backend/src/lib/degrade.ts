/**
 * Run a Supabase query without letting an unreachable host become a 500.
 *
 * The client resolves `{ data, error }` for anything the database says no to,
 * but a host that has stopped resolving never gets that far — `fetch` throws,
 * and with no catch the browser sees `TypeError: fetch failed` on a bell icon.
 * `getSupabase()` returning null only covers a store that was never configured;
 * this covers one that was configured and has since gone away.
 *
 * Callers decide what "no store" means for them: an empty list on a read, an
 * honest 503 on a write. What they must not do is claim a write succeeded.
 *
 * A synthesized error is marked `unreachable` so callers can keep telling the
 * two apart. A store that answered "row-level security forbids this" is a
 * misconfiguration on our side and still deserves a 500; a store that never
 * answered at all is a 503, and the difference is the first thing anyone
 * debugging this will want to know.
 */
export async function attempt<T extends { error: unknown }>(
  query: PromiseLike<T>,
): Promise<T> {
  try {
    return await query;
  } catch (err: any) {
    return {
      error: { message: String(err?.message ?? err), unreachable: true },
    } as unknown as T;
  }
}

/** True only for the error `attempt` synthesizes when the store never answered. */
export function isUnreachable(error: unknown): boolean {
  return !!error && (error as { unreachable?: boolean }).unreachable === true;
}
