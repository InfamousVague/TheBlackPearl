// Layout-matching loading placeholders. Reserving the final layout (a grid of
// poster cards) means content swaps in with zero layout shift, and — paired with the
// shared library cache — these only ever show on the first-ever load, never on revisit.
import { Skeleton } from "@mattmattmattmatt/base/primitives/skeleton/Skeleton";

/** A grid of poster-card skeletons that mirrors `.cat-grid` exactly. */
export function PosterGridSkeleton({ count = 12, square = false }: { count?: number; square?: boolean }) {
  return (
    <div className="cat-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="poster-card" key={i}>
          <div className={`poster${square ? " square" : ""}`}>
            <Skeleton full height="100%" aria-label="Loading" />
          </div>
          <div className="poster-meta">
            <Skeleton size="text-sm" width="80%" />
            <div style={{ marginTop: 6 }}>
              <Skeleton size="text-xs" width="45%" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
