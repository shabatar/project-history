import { useEffect, useRef, useState } from 'react';

function load<T>(key: string | null, initial: T): T {
  if (!key) return initial;
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}

/**
 * State backed by localStorage under `key`. When `key` changes (e.g. navigating
 * to a different report) the value reloads from that key's stored value, so each
 * report keeps its own settings. Pass `key = null` to disable persistence.
 */
export function usePersistentState<T>(key: string | null, initial: T) {
  const [value, setValue] = useState<T>(() => load(key, initial));
  // Suppress the persist write that immediately follows a key-driven reload,
  // so we don't clobber the new key with the previous value.
  const skipPersist = useRef(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return; // initial value already came from the initializer
    }
    skipPersist.current = true;
    setValue(load(key, initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    if (key) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore quota / unavailable */
      }
    }
  }, [key, value]);

  return [value, setValue] as const;
}
