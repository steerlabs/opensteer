import { useEffect, useState } from "react";

/**
 * True until `ms` have passed since `since` (epoch milliseconds), with one
 * timer and no ticking. Null is never quiet: a message being sent on a good
 * connection says nothing for its first second.
 */
export function useQuietMoment(since: number | null, ms: number): boolean {
  const ends = since === null ? null : since + ms;
  const [passed, setPassed] = useState<number | null>(null);
  useEffect(() => {
    if (ends === null) return;
    const left = ends - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setPassed(ends), left);
    return () => clearTimeout(timer);
  }, [ends]);
  return ends !== null && passed !== ends && Date.now() < ends;
}
