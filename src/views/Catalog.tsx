import { useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { PosterCard } from "../components/PosterCard";
import type { CatalogItem, Category, SortKey } from "../lib/types";
import { CATEGORY_LABEL, SORT_OPTIONS, sortCatalog } from "../lib/catalog";
import { ghost } from "../lib/icons";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";

interface CatalogProps {
  items: CatalogItem[];
  onPlay: (item: CatalogItem) => void;
}

const CATEGORY_ORDER: Category[] = ["video", "audio", "data", "books", "other"];

export function Catalog({ items, onPlay }: CatalogProps) {
  const [sort, setSort] = useState<SortKey>("popularity");
  const [category, setCategory] = useState<Category | "all">("all");

  const present = useMemo(() => {
    const set = new Set(items.map((i) => i.category));
    return CATEGORY_ORDER.filter((c) => set.has(c));
  }, [items]);

  const visible = useMemo(() => {
    const list = category === "all" ? items : items.filter((i) => i.category === category);
    return sortCatalog(list, sort);
  }, [items, category, sort]);

  return (
    <div>
      <div className="cat-header">
        <span className="cat-title">Catalog</span>
        <span className="cat-sub">{items.length} indexed</span>
        <div className="cat-controls">
          <SegmentedControl
            options={SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
          />
        </div>
      </div>

      <div className="cat-filters">
        <SegmentedControl
          options={[{ value: "all", label: "All" }, ...present.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]}
          value={category}
          onChange={(v) => setCategory(v as Category | "all")}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyCatalog hasItems={items.length > 0} />
      ) : (
        <div className="cat-grid">
          {visible.map((item) => (
            <PosterCard key={item.id} item={item} onPlay={() => onPlay(item)} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyCatalog({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="empty">
      <div className="empty-inner">
        <span className="empty-glyph"><Icon icon={ghost} size="xl" /></span>
        <h3>{hasItems ? "Nothing here" : "No torrents indexed yet"}</h3>
        <p>
          {hasItems
            ? "Try a different category, or search your sources from the bar above."
            : "Add a source in the Sources tab, then refresh — or just search above to pull results in live."}
        </p>
      </div>
    </div>
  );
}
