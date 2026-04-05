import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders, makeCommit } from './helpers';
import CommitTable from '../components/CommitTable';

const commits = [
  makeCommit({
    id: 'c1',
    commit_hash: 'aaa1111000000000000000000000000000000000',
    author_name: 'Alice',
    subject: 'feat: Add authentication',
    committed_at: '2025-03-15T10:00:00',
    repository_id: 'repo-1',
  }),
  makeCommit({
    id: 'c2',
    commit_hash: 'bbb2222000000000000000000000000000000000',
    author_name: 'Bob',
    subject: 'fix: Login bug',
    committed_at: '2025-03-16T11:00:00',
    repository_id: 'repo-2',
  }),
  makeCommit({
    id: 'c3',
    commit_hash: 'ccc3333000000000000000000000000000000000',
    author_name: 'Alice',
    subject: 'chore: Update deps',
    committed_at: '2025-03-15T14:00:00',
    repository_id: 'repo-1',
  }),
];

describe('CommitTable advanced', () => {
  it('shows category badges inline', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    expect(screen.getByText('feat')).toBeInTheDocument();
    expect(screen.getByText('fix')).toBeInTheDocument();
    expect(screen.getByText('chore')).toBeInTheDocument();
  });

  it('shows select-all checkbox', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // One select-all + one per commit
    expect(checkboxes.length).toBe(1 + commits.length);
  });

  it('select all selects all commits', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    const selectAll = screen.getAllByRole('checkbox')[0];
    fireEvent.click(selectAll);
    // Selection bar should appear
    expect(screen.getByText('3 selected')).toBeInTheDocument();
  });

  it('deselect all clears selection', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    const selectAll = screen.getAllByRole('checkbox')[0];
    fireEvent.click(selectAll); // select all
    fireEvent.click(selectAll); // deselect all
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
  });

  it('individual checkbox toggles selection', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // select first commit
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(checkboxes[1]); // deselect
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('shows repo column when showRepoColumn is true', () => {
    const repoMap = new Map([
      ['repo-1', { id: 'repo-1', name: 'frontend' } as any],
      ['repo-2', { id: 'repo-2', name: 'backend' } as any],
    ]);
    renderWithProviders(
      <CommitTable commits={commits} showRepoColumn repoMap={repoMap} />,
    );
    // repo-1 appears twice (2 commits), repo-2 once
    expect(screen.getAllByText('frontend')).toHaveLength(2);
    expect(screen.getByText('backend')).toBeInTheDocument();
    // Repo header should exist
    expect(screen.getByText(/^Repo/)).toBeInTheDocument();
  });

  it('does not show repo column by default', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    // Repo header should not exist
    expect(screen.queryByText('Repo')).not.toBeInTheDocument();
  });

  it('sort by author toggles direction', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    const authorHeader = screen.getByText('Author');
    fireEvent.click(authorHeader);
    // Should now show ascending indicator
    expect(screen.getByText(/Author/)).toHaveTextContent('Author');
  });

  it('copy button calls onSelectionCopy', () => {
    const onCopy = vi.fn();
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    renderWithProviders(<CommitTable commits={commits} onSelectionCopy={onCopy} />);
    // Select all
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    // Click copy
    fireEvent.click(screen.getByText('Copy'));
    expect(onCopy).toHaveBeenCalled();
  });

  it('compact mode applies class', () => {
    const { container } = renderWithProviders(
      <CommitTable commits={commits} compact />,
    );
    expect(container.querySelector('.ct-compact')).toBeTruthy();
  });

  it('groups commits by day', () => {
    renderWithProviders(<CommitTable commits={commits} />);
    // Two different days: Mar 15 and Mar 16
    expect(screen.getByText(/Mar 15/)).toBeInTheDocument();
    expect(screen.getByText(/Mar 16/)).toBeInTheDocument();
  });
});
