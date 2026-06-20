import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { chevronLeft, chevronRight } from "../lib/icons";

interface PosterRowProps<T = unknown> {
  title: string;
  count?: number;
  children?: ReactNode;
  /** Optional lazy source list to avoid eagerly materializing every child element. */
  items?: readonly T[];
  /** Item renderer used with `items` for lazy row rendering. */
  renderItem?: (item: T, index: number) => ReactNode;
}

const INITIAL_ITEMS = 24;
const LOAD_CHUNK = 24;

/** A titled Netflix-style horizontal rail of poster cards with scroll arrows. */
export function PosterRow<T>({ title, count, children, items, renderItem }: PosterRowProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const childArray = useMemo(() => (items && renderItem ? null : Children.toArray(children)), [children, items, renderItem]);
  const totalCount = items && renderItem ? items.length : (childArray?.length ?? 0);
  const [visibleCount, setVisibleCount] = useState(() => Math.min(INITIAL_ITEMS, totalCount));

  useEffect(() => {
    setVisibleCount(Math.min(INITIAL_ITEMS, totalCount));
  }, [totalCount]);

  const maybeGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (visibleCount >= totalCount) return;
    const nearEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - Math.max(180, el.clientWidth * 0.5);
    if (nearEnd) {
      setVisibleCount((cur) => Math.min(totalCount, cur + LOAD_CHUNK));
    }
  }, [totalCount, visibleCount]);

  useEffect(() => {
    const id = window.setTimeout(maybeGrow, 0);
    return () => window.clearTimeout(id);
  }, [maybeGrow]);

  const scrollBy = (dir: number) => () => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
    window.setTimeout(maybeGrow, 220);
  };

  const visible = useMemo(() => {
    if (items && renderItem) {
      return items.slice(0, visibleCount).map((item, idx) => renderItem(item, idx));
    }
    return (childArray ?? []).slice(0, visibleCount);
  }, [childArray, items, renderItem, visibleCount]);

  return (
    <section className="prow">
      <div className="prow-head">
        <h2 className="prow-title">
          {title}
          {count != null && <span className="prow-count">{count}</span>}
        </h2>
        <div className="prow-arrows">
          <button className="prow-arrow" aria-label="Scroll left" onClick={scrollBy(-1)}>
            <Icon icon={chevronLeft} size="sm" />
          </button>
          <button className="prow-arrow" aria-label="Scroll right" onClick={scrollBy(1)}>
            <Icon icon={chevronRight} size="sm" />
          </button>
        </div>
      </div>
      <div className="prow-scroller" ref={ref} onScroll={maybeGrow}>
        {visible}
      </div>
    </section>
  );
}
