/**
 * State that lasts one request, across every render Next makes of it.
 *
 * React's cache() lasts one render. When a page fails, Next renders again for the error page and runs
 * generateMetadata anew, so a read memoised with cache() is made a second time, on a fresh budget,
 * after the request has already failed (CRI-47). Key the state on the request's headers object, the
 * value of `await headers()`, which every render of one request is handed; it goes when the request
 * does.
 *
 * No imports, so tests can load it.
 */
export function perRequest<T>(init: () => T): (request: object) => T {
  const states = new WeakMap<object, T>();
  return (request) => {
    let state = states.get(request);
    if (state === undefined) states.set(request, (state = init()));
    return state;
  };
}
