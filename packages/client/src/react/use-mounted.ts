import { useEffect, useRef } from "react";

/** Whether the component is still shown: an answer that arrives after it is gone must not act. */
export function useMountedRef(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
