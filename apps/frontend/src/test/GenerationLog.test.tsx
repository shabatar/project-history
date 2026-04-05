import { describe, it, expect, beforeAll } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import GenerationLog, { createLogEntry } from '../components/GenerationLog';

// scrollIntoView is not available in jsdom
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

describe('GenerationLog', () => {
  it('renders nothing when not visible', () => {
    const entries = [createLogEntry('test', 'info')];
    const { container } = renderWithProviders(
      <GenerationLog entries={entries} visible={false} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when entries are empty', () => {
    const { container } = renderWithProviders(
      <GenerationLog entries={[]} visible={true} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders log entries when visible', () => {
    const entries = [
      createLogEntry('Starting...', 'step'),
      createLogEntry('Done!', 'success'),
    ];
    renderWithProviders(<GenerationLog entries={entries} visible={true} />);
    expect(screen.getByText('Starting...')).toBeInTheDocument();
    expect(screen.getByText('Done!')).toBeInTheDocument();
  });

  it('shows event count', () => {
    const entries = [
      createLogEntry('A', 'info'),
      createLogEntry('B', 'info'),
      createLogEntry('C', 'error'),
    ];
    renderWithProviders(<GenerationLog entries={entries} visible={true} />);
    expect(screen.getByText('3 events')).toBeInTheDocument();
  });

  it('createLogEntry creates proper structure', () => {
    const entry = createLogEntry('hello', 'error');
    expect(entry.message).toBe('hello');
    expect(entry.type).toBe('error');
    expect(entry.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
