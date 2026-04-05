import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import dayjs from 'dayjs';
import type { DateRange, SummaryStyle, LocalSettings } from '../types';

export type Theme = 'dark' | 'light' | 'auto';

interface AppState {
  selectedRepoId: string | null;
  dateRange: DateRange;
  summaryStyle: SummaryStyle;
  settings: LocalSettings;
  theme: Theme;
  setSelectedRepoId: (id: string | null) => void;
  setDateRange: (range: DateRange) => void;
  setSummaryStyle: (style: SummaryStyle) => void;
  setSettings: (settings: Partial<LocalSettings>) => void;
  setTheme: (theme: Theme) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedRepoId: null,
      dateRange: {
        from: dayjs().subtract(30, 'day').format('YYYY-MM-DD'),
        to: dayjs().format('YYYY-MM-DD'),
      },
      summaryStyle: 'detailed',
      settings: {
        ollamaBaseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        issueTrackerType: 'none',
        issueTrackerUrl: '',
      },
      theme: 'auto',
      setSelectedRepoId: (id) => set({ selectedRepoId: id }),
      setDateRange: (range) => set({ dateRange: range }),
      setSummaryStyle: (style) => set({ summaryStyle: style }),
      setSettings: (partial) =>
        set((state) => ({
          settings: { ...state.settings, ...partial },
        })),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'project-history-settings',
      partialize: (state) => ({
        settings: state.settings,
        summaryStyle: state.summaryStyle,
        theme: state.theme,
      }),
      merge: (persisted: any, current) => ({
        ...current,
        ...persisted,
        // Ensure new fields have defaults even if missing from old persisted data
        theme: persisted?.theme || 'auto',
        settings: {
          ...current.settings,
          ...(persisted?.settings || {}),
          issueTrackerType: persisted?.settings?.issueTrackerType || 'none',
          issueTrackerUrl: persisted?.settings?.issueTrackerUrl || '',
        },
      }),
    },
  ),
);
