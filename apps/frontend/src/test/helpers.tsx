import type { ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

export function renderWithProviders(
  ui: ReactNode,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: createWrapper(), ...options });
}

export function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'repo-1',
    name: 'test-repo',
    remote_url: 'https://github.com/test/repo.git',
    default_branch: 'main',
    last_synced_at: null,
    is_active: true,
    commit_count: 0,
    ...overrides,
  };
}

export function makeCommit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'commit-1',
    repository_id: 'repo-1',
    commit_hash: 'abc1234567890abcdef1234567890abcdef123456',
    author_name: 'Alice',
    author_email: 'alice@test.com',
    committed_at: '2025-03-15T10:00:00',
    subject: 'Add feature X',
    body: 'Detailed description of feature X',
    ...overrides,
  };
}
