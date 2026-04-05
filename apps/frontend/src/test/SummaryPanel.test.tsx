import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import SummaryPanel from '../components/SummaryPanel';
import type { SummaryJob } from '../types';

const completedJob: SummaryJob = {
  id: 'job-1',
  repository_id: 'repo-1',
  start_date: '2025-03-01',
  end_date: '2025-03-15',
  branch: null,
  base_branch: null,
  model_name: 'llama3.1',
  summary_style: 'detailed',
  status: 'completed',
  created_at: '2025-03-15T12:00:00',
  result: {
    id: 'result-1',
    summary_job_id: 'job-1',
    summary_markdown: '## High-Level Summary\nAuthentication improvements and bug fixes.',
    commit_count: 5,
    generated_at: '2025-03-15T12:01:00',
  },
};

const failedJob: SummaryJob = {
  id: 'job-2',
  repository_id: 'repo-1',
  start_date: '2025-03-01',
  end_date: '2025-03-15',
  branch: null,
  base_branch: null,
  model_name: 'llama3.1',
  summary_style: 'short',
  status: 'failed',
  created_at: '2025-03-15T13:00:00',
  result: null,
};

describe('SummaryPanel', () => {
  it('shows empty state when no jobs', () => {
    renderWithProviders(<SummaryPanel jobs={[]} />);
    expect(screen.getByText('No summaries yet.')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    renderWithProviders(<SummaryPanel jobs={[]} loading />);
    expect(screen.getByText('Loading summaries...')).toBeInTheDocument();
  });

  it('renders completed summary with markdown', () => {
    renderWithProviders(<SummaryPanel jobs={[completedJob]} />);
    expect(screen.getByText(/5\s*commits/)).toBeInTheDocument();
    expect(screen.getByText('llama3.1')).toBeInTheDocument();
    expect(screen.getByText('Detailed')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    // Markdown rendered to HTML
    expect(screen.getByText('High-Level Summary')).toBeInTheDocument();
  });

  it('shows error banner for failed job', () => {
    renderWithProviders(<SummaryPanel jobs={[failedJob]} />);
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(
      screen.getByText(/Summary generation failed/),
    ).toBeInTheDocument();
  });

  it('renders multiple jobs', () => {
    renderWithProviders(<SummaryPanel jobs={[completedJob, failedJob]} />);
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });
});
