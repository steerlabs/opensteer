import { useEffect, useState } from "react";

/** The value once it has stopped changing for `ms`; for a search sent to the Host, not each keystroke. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
