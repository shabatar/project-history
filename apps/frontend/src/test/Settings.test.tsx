import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';

vi.mock('../lib/hooks', () => ({
  useOllamaModels: () => ({ data: [], isError: false }),
}));

vi.mock('../lib/linkify', () => ({
  configureIssueTracker: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  pullModel: vi.fn(),
  listRunningModels: vi.fn().mockResolvedValue([]),
  loadModel: vi.fn(),
  unloadModel: vi.fn(),
  deleteModel: vi.fn(),
}));

const mockSettings = {
  ollamaBaseUrl: 'http://localhost:11434',
  defaultModel: 'llama3.1',
  issueTrackerType: 'none' as const,
  issueTrackerUrl: '',
};

const mockStore = {
  settings: { ...mockSettings },
  setSettings: vi.fn(),
  summaryStyle: 'detailed' as const,
  setSummaryStyle: vi.fn(),
};

vi.mock('../store', () => ({
  useAppStore: (selector?: (state: typeof mockStore) => unknown) =>
    selector ? selector(mockStore) : mockStore,
}));

beforeEach(() => {
  mockStore.settings = { ...mockSettings };
  mockStore.setSettings.mockClear();
  mockStore.setSummaryStyle.mockClear();
});

describe('Settings', () => {
  it('renders model server URL input', async () => {
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    const input = screen.getByLabelText('Server URL');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('http://localhost:11434');
  });

  it('renders summary style selector', async () => {
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    const select = screen.getByLabelText('Default Summary Style');
    expect(select).toBeInTheDocument();
  });

  it('renders summary style selector with options Short, Detailed, Briefly', async () => {
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    const select = screen.getByLabelText('Default Summary Style');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('Short')).toBeInTheDocument();
    expect(screen.getByText('Detailed (engineering)')).toBeInTheDocument();
    expect(screen.getByText('Briefly')).toBeInTheDocument();
  });

  it('renders issue tracker type selector', async () => {
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    const select = screen.getByLabelText('Tracker Type');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText('YouTrack')).toBeInTheDocument();
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.getByText('GitHub Issues')).toBeInTheDocument();
  });

  it('shows URL field when YouTrack is selected', async () => {
    mockStore.settings = { ...mockSettings, issueTrackerType: 'youtrack' };
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    expect(screen.getByLabelText('YouTrack URL')).toBeInTheDocument();
  });

  it('shows URL field when Jira is selected', async () => {
    mockStore.settings = { ...mockSettings, issueTrackerType: 'jira' };
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    expect(screen.getByLabelText('Jira URL')).toBeInTheDocument();
  });

  it('hides URL field when None is selected', async () => {
    mockStore.settings = { ...mockSettings, issueTrackerType: 'none' };
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    expect(screen.queryByLabelText('YouTrack URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Jira URL')).not.toBeInTheDocument();
  });

  it('hides URL field when GitHub is selected', async () => {
    mockStore.settings = { ...mockSettings, issueTrackerType: 'github' };
    const { default: Settings } = await import('../pages/Settings');
    renderWithProviders(<Settings />);
    expect(screen.queryByLabelText('YouTrack URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Jira URL')).not.toBeInTheDocument();
  });
});
