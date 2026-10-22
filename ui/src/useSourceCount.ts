import { useEffect, useState } from "react";
import { api, pb } from "./api";

/** Total original evidence in the selected space, independent of publication/search. */
export function useSourceCount(space?: string): number | null {
  const [authEpoch, setAuthEpoch] = useState(0);
  const [result, setResult] = useState<{
    space: string;
    token: string;
    count: number;
  } | null>(null);
  useEffect(
    () => pb.authStore.onChange(() => setAuthEpoch((value) => value + 1)),
    [],
  );
  useEffect(() => {
    setResult(null);
    if (!space || !pb.authStore.isValid) return;
    const token = pb.authStore.token;
    let active = true,
      request = 0;
    let stop: (() => void) | undefined;
    const refresh = async () => {
      const version = ++request;
      try {
        const count = await api.sourceCount(space);
        if (active && version === request && token === pb.authStore.token)
          setResult({ space, token, count });
      } catch {
        if (active && version === request) setResult(null);
      }
    };
    void refresh();
    const refreshOnFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("online", refreshOnFocus);
    const timer = window.setInterval(refreshOnFocus, 60_000);
    void api
      .watchSources(() => {
        void refresh();
      })
      .then((dispose) => {
        if (active) stop = dispose;
        else dispose();
      })
      .catch(() => {});
    return () => {
      active = false;
      stop?.();
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("online", refreshOnFocus);
    };
  }, [space, authEpoch]);
  return result &&
    result.space === space &&
    result.token === pb.authStore.token &&
    pb.authStore.isValid
    ? result.count
    : null;
}
