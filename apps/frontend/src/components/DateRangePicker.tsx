import { useMemo } from 'react';
import dayjs from 'dayjs';
import type { DateRange } from '../types';

export type DatePreset = 'today' | 'yesterday' | 'last7' | 'thisMonth';

interface Props {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

function computePreset(range: DateRange): DatePreset | null {
  const today = dayjs().format('YYYY-MM-DD');
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const week = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

  if (range.from === today && range.to === today) return 'today';
  if (range.from === yesterday && range.to === yesterday) return 'yesterday';
  if (range.from === week && range.to === today) return 'last7';
  if (range.from === monthStart && range.to === today) return 'thisMonth';
  return null;
}

function presetToRange(preset: DatePreset): DateRange {
  const today = dayjs().format('YYYY-MM-DD');
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
      return { from: y, to: y };
    }
    case 'last7':
      return { from: dayjs().subtract(6, 'day').format('YYYY-MM-DD'), to: today };
    case 'thisMonth':
      return { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: today };
  }
}

const PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: '7 days' },
  { value: 'thisMonth', label: 'Month' },
];

export default function DateRangePicker({ value, onChange }: Props) {
  const activePreset = useMemo(() => computePreset(value), [value]);

  return (
    <div className="date-range-picker">
      <div className="date-presets">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`btn btn-sm date-preset${activePreset === p.value ? ' date-preset-active' : ''}`}
            onClick={() => onChange(presetToRange(p.value))}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="date-range-fields">
        <label className="date-range-field">
          <span className="date-range-label">From</span>
          <input
            type="date"
            className="input"
            value={value.from}
            onChange={(e) => {
              if (e.target.value) onChange({ from: e.target.value, to: value.to });
            }}
          />
        </label>
        <label className="date-range-field">
          <span className="date-range-label">To</span>
          <input
            type="date"
            className="input"
            value={value.to}
            onChange={(e) => {
              if (e.target.value) onChange({ ...value, to: e.target.value });
            }}
          />
        </label>
      </div>
    </div>
  );
}
