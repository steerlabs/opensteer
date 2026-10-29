import { useCallback, useRef } from "react";
import type { ScrollViewInstance } from "react-native";

/** A list's place, held by whatever outlives the views that draw it. */
export interface ScrollMemory {
  offset: number;
}

interface ScrollEnd {
  readonly nativeEvent: { readonly contentOffset: { readonly y: number } };
}

/**
 * Keeps a scrolling list's place in `memory` and returns a new view of it to
 * that place. The place is the reader's: it is written only where their own
 * drag or fling ends, never by the list moving itself. It is restored once, as
 * soon as the rows are there to hold it, and not at all once the reader has
 * scrolled the new view themselves.
 */
export function useRetainedScroll(memory: ScrollMemory) {
  const ref = useRef<ScrollViewInstance>(null);
  const pending = useRef(memory.offset > 0);
  const viewport = useRef(0);
  const record = useCallback(
    (event: ScrollEnd) => {
      pending.current = false;
      memory.offset = event.nativeEvent.contentOffset.y;
    },
    [memory],
  );
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      if (!pending.current || height < memory.offset + viewport.current) return;
      pending.current = false;
      ref.current?.scrollTo({ animated: false, y: memory.offset });
    },
    [memory],
  );
  const onLayout = useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    viewport.current = event.nativeEvent.layout.height;
  }, []);
  return {
    onContentSizeChange,
    onLayout,
    onMomentumScrollEnd: record,
    onScrollEndDrag: record,
    ref,
  };
}
