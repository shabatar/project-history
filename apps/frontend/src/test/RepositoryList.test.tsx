import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders, makeRepo } from './helpers';
import RepositoryList from '../components/RepositoryList';

const noop = vi.fn();

describe('RepositoryList', () => {
  it('shows empty state when no repos', () => {
    renderWithProviders(
      <RepositoryList
        repositories={[]}
        selectedId={null}
        repoStatuses={{}}
        syncLogs={{}}
        onSelect={noop}
        onClone={noop}
        onPull={noop}
        onDelete={noop}
        onRefresh={noop}
        onOpenFolder={noop}
      />,
    );
    expect(screen.getByText('No repositories yet.')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    renderWithProviders(
      <RepositoryList
        repositories={[]}
        selectedId={null}
        repoStatuses={{}}
        syncLogs={{}}
        onSelect={noop}
        onClone={noop}
        onPull={noop}
        onDelete={noop}
        onRefresh={noop}
        onOpenFolder={noop}
        loading
      />,
    );
    expect(screen.getByText('Loading repositories...')).toBeInTheDocument();
  });

  it('renders repo cards', () => {
    const repos = [
      makeRepo({ id: 'r1', name: 'alpha' }),
      makeRepo({ id: 'r2', name: 'beta', last_synced_at: '2025-03-20T10:00:00' }),
    ];

    renderWithProviders(
      <RepositoryList
        repositories={repos}
        selectedId="r2"
        repoStatuses={{}}
        syncLogs={{}}
        onSelect={noop}
        onClone={noop}
        onPull={noop}
        onDelete={noop}
        onRefresh={noop}
        onOpenFolder={noop}
      />,
    );

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    // alpha is not cloned — should show Clone button
    expect(screen.getByText('Clone')).toBeInTheDocument();
    // beta is cloned — should show Pull / Update
    expect(screen.getByText('Pull / Update')).toBeInTheDocument();
  });

  it('shows syncing status', () => {
    const repos = [makeRepo({ id: 'r1', name: 'syncing-repo' })];

    renderWithProviders(
      <RepositoryList
        repositories={repos}
        selectedId={null}
        repoStatuses={{ r1: 'syncing' }}
        syncLogs={{ r1: 'Cloning repository...' }}
        onSelect={noop}
        onClone={noop}
        onPull={noop}
        onDelete={noop}
        onRefresh={noop}
        onOpenFolder={noop}
      />,
    );

    expect(screen.getByText('Syncing...')).toBeInTheDocument();
    expect(screen.getByText('Cloning repository...')).toBeInTheDocument();
  });
});
