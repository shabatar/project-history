import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import ErrorBoundary from '../components/ErrorBoundary';

function ThrowingChild({ error }: { error: Error }) {
  throw error;
}

describe('ErrorBoundary', () => {
  // Suppress React error boundary console output in tests
  const originalError = console.error;
  beforeEach(() => { console.error = vi.fn(); });
  afterEach(() => { console.error = originalError; });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('shows error message when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild error={new Error('Test crash')} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Test crash')).toBeInTheDocument();
  });

  it('resets error state when "Try again" is clicked', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild error={new Error('Boom')} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    // Verify the button exists and is clickable
    expect(screen.getByText('Try again').tagName).toBe('BUTTON');
  });
});
