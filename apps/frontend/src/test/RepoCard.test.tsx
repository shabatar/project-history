import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders, makeRepo } from './helpers';
import RepoCard from '../components/RepoCard';

const noop = () => {};

const baseProps = {
  selected: false,
  status: 'cloned' as const,
  syncLog: null,
  onSelect: noop,
  onClone: noop,
  onPull: noop,
  onDelete: noop,
  onRefresh: noop,
  onOpenFolder: noop,
};

describe('RepoCard', () => {
  it('renders repo name and status', () => {
    renderWithProviders(
      <RepoCard repo={makeRepo({ name: 'my-app' })} {...baseProps} />,
    );
    expect(screen.getByText('my-app')).toBeInTheDocument();
    expect(screen.getByText('Cloned')).toBeInTheDocument();
  });

  it('shows "Not cloned" status and Clone button', () => {
    renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} status="not_cloned" />,
    );
    expect(screen.getByText('Not cloned')).toBeInTheDocument();
    expect(screen.getByText('Clone')).toBeInTheDocument();
  });

  it('shows Pull button when cloned', () => {
    renderWithProviders(
      <RepoCard
        repo={makeRepo({ last_synced_at: '2025-03-15T10:00:00' })}
        {...baseProps}
      />,
    );
    expect(screen.getByText('Pull / Update')).toBeInTheDocument();
  });

  it('calls onSelect when clicked', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText('test-repo'));
    expect(onSelect).toHaveBeenCalledWith('repo-1');
  });

  it('calls onClone when Clone button clicked', () => {
    const onClone = vi.fn();
    renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} status="not_cloned" onClone={onClone} />,
    );
    fireEvent.click(screen.getByText('Clone'));
    expect(onClone).toHaveBeenCalledWith('repo-1');
  });

  it('calls onDelete when Remove button clicked', () => {
    const onDelete = vi.fn();
    renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByText('Remove'));
    expect(onDelete).toHaveBeenCalledWith('repo-1');
  });

  it('disables buttons when syncing', () => {
    renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} status="syncing" />,
    );
    expect(screen.getByText('Cloning...')).toBeInTheDocument();
    expect(screen.getByText('Cloning...')).toBeDisabled();
  });

  it('shows sync log when present', () => {
    renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} syncLog="Pull complete." />,
    );
    expect(screen.getByText('Pull complete.')).toBeInTheDocument();
  });

  it('shows selected state', () => {
    const { container } = renderWithProviders(
      <RepoCard repo={makeRepo()} {...baseProps} selected />,
    );
    expect(container.querySelector('.repo-card.selected')).toBeTruthy();
  });

  it('shows commit count and branch', () => {
    renderWithProviders(
      <RepoCard
        repo={makeRepo({ commit_count: 42, default_branch: 'develop' })}
        {...baseProps}
      />,
    );
    expect(screen.getByText('42 commits')).toBeInTheDocument();
    expect(screen.getByText('branch: develop')).toBeInTheDocument();
  });
});
