import { vi } from "vitest";

/**
 * A chainable stand-in for a Supabase query builder. Any method call
 * (select/eq/order/limit/upsert/insert/update/ilike/single/...) returns the
 * same proxy so arbitrary chains work; awaiting it (or calling .then) always
 * resolves to the fixed `result`. Good enough for route tests that only care
 * about our route's handling of the eventual `{ data, error }`, not the
 * exact query Supabase would build.
 */
export function chainableResult(result: { data: unknown; error: unknown }) {
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: typeof result) => void) => resolve(result);
        }
        return (..._args: unknown[]) => proxy;
      },
    },
  );
  return proxy;
}

export function makeSupabaseMock(opts: {
  from?: (table: string) => any;
  storage?: {
    createBucket?: ReturnType<typeof vi.fn>;
    upload?: ReturnType<typeof vi.fn>;
    getPublicUrl?: ReturnType<typeof vi.fn>;
  };
}) {
  const storageUpload = opts.storage?.upload ?? vi.fn(async () => ({ error: null }));
  const storageGetPublicUrl =
    opts.storage?.getPublicUrl ??
    vi.fn((path: string) => ({ data: { publicUrl: `https://mock.supabase.co/${path}` } }));
  const storageCreateBucket = opts.storage?.createBucket ?? vi.fn(async () => ({ error: null }));

  return {
    from: opts.from ?? (() => chainableResult({ data: null, error: null })),
    storage: {
      createBucket: storageCreateBucket,
      from: vi.fn(() => ({
        upload: storageUpload,
        getPublicUrl: storageGetPublicUrl,
      })),
    },
  };
}

/**
 * A query builder for a store that is configured but no longer answers.
 *
 * `chainableResult` models a store that replies "no" — a row-level-security
 * refusal, a bad column. This models the other failure: the host stopped
 * resolving, so `fetch` throws before there is any `{ data, error }` at all.
 * That is the case that produced raw 500s in production, and it cannot be
 * reproduced with a resolved error object.
 */
export function chainableThrows(message = "fetch failed") {
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (_resolve: unknown, reject: (e: Error) => void) =>
            reject(new TypeError(message));
        }
        return (..._args: unknown[]) => proxy;
      },
    },
  );
  return proxy;
}
