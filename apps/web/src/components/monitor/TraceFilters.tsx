import type { RunTraceCategory } from '@suanlizi/protocol';
import { traceCategoryLabel, traceIcon } from '../../features/monitor/traceFormatters.js';

interface TraceFiltersProps {
  categories: RunTraceCategory[];
  selectedCategories: RunTraceCategory[];
  errorsOnly: boolean;
  zh: boolean;
  onToggleCategory(category: RunTraceCategory): void;
  onSetCategoryFilter(categories: RunTraceCategory[]): void;
  onToggleErrorsOnly(): void;
}

export function TraceFilters({
  categories,
  selectedCategories,
  errorsOnly,
  zh,
  onToggleCategory,
  onSetCategoryFilter,
  onToggleErrorsOnly,
}: TraceFiltersProps) {
  const allSelected = selectedCategories.length === 0;

  return (
    <div className="traceFilters">
      <div className="traceFilterChips">
        <button
          type="button"
          className={`traceChip ${allSelected ? 'traceChip--active' : ''}`}
          aria-pressed={allSelected}
          onClick={() => onSetCategoryFilter([])}
        >
          {zh ? '全部' : 'All'}
        </button>
        {categories.map((cat) => {
          const active = selectedCategories.includes(cat);
          return (
            <button
              key={cat}
              type="button"
              className={`traceChip ${active ? 'traceChip--active' : ''}`}
              aria-pressed={active}
              onClick={() => onToggleCategory(cat)}
              title={traceCategoryLabel(cat, zh)}
            >
              <span className="traceChip__icon">{traceIcon(cat)}</span>
              <span className="traceChip__label">{traceCategoryLabel(cat, zh)}</span>
            </button>
          );
        })}
      </div>
      <label className="traceErrorsOnly">
        <input
          type="checkbox"
          checked={errorsOnly}
          onChange={onToggleErrorsOnly}
          aria-label={zh ? '仅显示错误' : 'Show errors only'}
        />
        <span>{zh ? '仅错误' : 'Errors only'}</span>
      </label>
    </div>
  );
}
