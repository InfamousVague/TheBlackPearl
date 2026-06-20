import { useEffect, useRef, useState } from "react";

/**
 * Dependency-free "render one page, load more on scroll" windowing for big lists/grids.
 *
 * Mounting thousands of cards at once locks the main thread when React COMMITS them — and the
 * commit phase can't be interrupted by `startTransition` (only the render phase can), which is
 * why a big Library/TV-Shows page still freezes for ~a second. This caps the mounted DOM to a
 * window that grows by `pageSize` each time a sentinel near the bottom scrolls into view, so the
 * committed node count stays small no matter how large the library is.
 *
 * Pass the FULL (ideally memoized) array. Render `visible`, and put `sentinelRef` on an element
 * placed right after the rendered items. The window resets to the first page whenever `items`
 * changes (a new filter/sort/refresh), so navigation always starts light at the top.
 *
 * The observer uses the viewport as root (root: null), which works even when the list lives in a
 * nested scroll container — the sentinel's viewport-relative position still changes on scroll.
 */
export function useInfiniteScroll<T>(items: T[], pageSize = 48) {
  const [count, setCount] = useState(pageSize);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset to the first page when the underlying list changes (filter, sort, data refresh).
  useEffect(() => {
    setCount(pageSize);
  }, [items, pageSize]);

  // Grow the window as the sentinel approaches the viewport. Re-runs on `count` so that if the
  // sentinel is still visible after a page loads, the next page loads too (auto-fills a tall
  // viewport); it stops once everything is rendered.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || count >= items.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setCount((c) => Math.min(c + pageSize, items.length));
        }
      },
      { rootMargin: "800px" }, // start loading the next page before the user reaches the end
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, count, pageSize]);

  return {
    visible: count >= items.length ? items : items.slice(0, count),
    sentinelRef,
    hasMore: count < items.length,
  };
}
