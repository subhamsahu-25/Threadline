import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async ({ quiet = false } = {}) => {
    const id = requestId.current + 1;
    requestId.current = id;
    if (!quiet) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loaderRef.current();
      // A slower earlier request must not overwrite a newer result.
      if (mounted.current && id === requestId.current) {
        setState({ data, error: null, loading: false });
      }
      return data;
    } catch (error) {
      if (mounted.current && id === requestId.current && error?.name !== 'AbortError') {
        // Keep the last good data so a failed refresh does not blank the page.
        setState((current) => ({ ...current, error, loading: false }));
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    run().catch(() => {});
    // Any change of dependencies invalidates a request still in flight.
    return () => {
      requestId.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload: run };
}
