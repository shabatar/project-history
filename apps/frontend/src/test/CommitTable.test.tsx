import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders, makeCommit } from './helpers';
import CommitTable from '../components/CommitTable';

const commits = [
  makeCommit({
    id: 'c1',
    commit_hash: 'aaa1111000000000000000000000000000000000',
    author_name: 'Alice',
    subject: 'Add authentication',
    body: 'JWT implementation',
    committed_at: '2025-03-15T10:00:00',
  }),
  makeCommit({
    id: 'c2',
    commit_hash: 'bbb2222000000000000000000000000000000000',
    author_name: 'Bob',
    subject: 'Fix login bug',
    body: '',
    committed_at: '2025-03-16T11:00:00',
  }),
  makeCommit({
    id: 'c3',
    commit_hash: 'ccc3333000000000000000000000000000000000',
    author_name: 'Alice',
    subject: 'Refactor database',
    body: 'Moved to repository pattern',
    committed_at: '2025-03-17T09:00:00',
  }),
];

describe('CommitTable', () => {
  it('shows empty state when no commits', () => {
    renderWithProviders(<CommitTable commits={[]} />);
    expect(screen.getByText('No commits found.')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    renderWithProviders(<CommitTable commits={[]} loading />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders all commits', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    expect(screen.getByText('Add authentication')).toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('Refactor database')).toBeInTheDocument();
  });

  it('filters by search text (subject)', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: 'database' },
    });
    expect(screen.getByText('Refactor database')).toBeInTheDocument();
    expect(screen.queryByText('Fix login bug')).not.toBeInTheDocument();
  });

  it('filters by author name via search', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: 'Bob' },
    });
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.queryByText('Add authentication')).not.toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('search matches commit body', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: 'JWT' },
    });
    expect(screen.getByText('Add authentication')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('expands commit body on click', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    expect(screen.queryByText('JWT implementation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Add authentication'));
    expect(screen.getByText('JWT implementation')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add authentication'));
    expect(screen.queryByText('JWT implementation')).not.toBeInTheDocument();
  });
});
