import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loaderRef.current();
      if (mounted.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (mounted.current && error?.name !== 'AbortError') {
        setState((current) => ({ ...current, error, loading: false }));
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((data) => {
        if (active) setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (active && error?.name !== 'AbortError') {
          setState({ data: null, error, loading: false });
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload };
}
