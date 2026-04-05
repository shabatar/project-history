import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import AddRepositoryForm from '../components/AddRepositoryForm';

const noop = vi.fn();

function renderForm(overrides = {}) {
  return renderWithProviders(
    <AddRepositoryForm onAddRemote={noop} onAddLocal={noop} {...overrides} />,
  );
}

describe('AddRepositoryForm — Remote mode', () => {
  it('renders tabs and input', () => {
    renderForm();
    expect(screen.getByText('Remote URL')).toBeInTheDocument();
    expect(screen.getByText('Local Folder')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/git@host/)).toBeInTheDocument();
    expect(screen.getByText('Add Repository')).toBeInTheDocument();
  });

  it('button is disabled when input is empty', () => {
    renderForm();
    expect(screen.getByText('Add Repository')).toBeDisabled();
  });

  it('shows validation error for invalid URL on blur', () => {
    renderForm();
    const input = screen.getByPlaceholderText(/git@host/);
    fireEvent.change(input, { target: { value: 'not-a-url' } });
    fireEvent.blur(input);
    expect(screen.getByText(/HTTPS or SSH URL/)).toBeInTheDocument();
  });

  it('shows inferred repo name for valid URL', () => {
    renderForm();
    const input = screen.getByPlaceholderText(/git@host/);
    fireEvent.change(input, {
      target: { value: 'https://github.com/user/my-project.git' },
    });
    expect(screen.getByText('my-project')).toBeInTheDocument();
  });

  it('calls onAddRemote with trimmed URL on submit', () => {
    const onAddRemote = vi.fn();
    renderForm({ onAddRemote });
    const input = screen.getByPlaceholderText(/git@host/);
    fireEvent.change(input, {
      target: { value: 'https://github.com/user/repo.git' },
    });
    fireEvent.submit(input.closest('form')!);
    expect(onAddRemote).toHaveBeenCalledWith('https://github.com/user/repo.git');
  });

  it('clears input after submit', () => {
    renderForm();
    const input = screen.getByPlaceholderText(/git@host/) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://github.com/user/repo.git' },
    });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('');
  });

  it('does not submit invalid URL', () => {
    const onAddRemote = vi.fn();
    renderForm({ onAddRemote });
    const input = screen.getByPlaceholderText(/git@host/);
    fireEvent.change(input, { target: { value: 'https://invalid' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAddRemote).not.toHaveBeenCalled();
  });

  it('accepts SSH URLs', () => {
    const onAddRemote = vi.fn();
    renderForm({ onAddRemote });
    const input = screen.getByPlaceholderText(/git@host/);
    fireEvent.change(input, {
      target: { value: 'git@github.com:user/my-repo.git' },
    });
    expect(screen.getByText('my-repo')).toBeInTheDocument();
    fireEvent.submit(input.closest('form')!);
    expect(onAddRemote).toHaveBeenCalledWith('git@github.com:user/my-repo.git');
  });
});

describe('AddRepositoryForm — Local mode', () => {
  it('switches to local mode on tab click', () => {
    renderForm();
    fireEvent.click(screen.getByText('Local Folder'));
    expect(screen.getByPlaceholderText(/\/path\/to/)).toBeInTheDocument();
    expect(screen.getByText('Open Local Repo')).toBeInTheDocument();
  });

  it('validates path must be absolute', () => {
    renderForm();
    fireEvent.click(screen.getByText('Local Folder'));
    const input = screen.getByPlaceholderText(/\/path\/to/);
    fireEvent.change(input, { target: { value: 'relative/path' } });
    fireEvent.blur(input);
    expect(screen.getByText(/absolute path/)).toBeInTheDocument();
  });

  it('shows inferred name from folder path', () => {
    renderForm();
    fireEvent.click(screen.getByText('Local Folder'));
    const input = screen.getByPlaceholderText(/\/path\/to/);
    fireEvent.change(input, { target: { value: '/Users/me/my-project' } });
    expect(screen.getByText('my-project')).toBeInTheDocument();
  });

  it('calls onAddLocal with path on submit', () => {
    const onAddLocal = vi.fn();
    renderForm({ onAddLocal });
    fireEvent.click(screen.getByText('Local Folder'));
    const input = screen.getByPlaceholderText(/\/path\/to/);
    fireEvent.change(input, { target: { value: '/Users/me/project' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAddLocal).toHaveBeenCalledWith('/Users/me/project');
  });

  it('clears input when switching modes', () => {
    renderForm();
    const input = screen.getByPlaceholderText(/git@host/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'some text' } });
    fireEvent.click(screen.getByText('Local Folder'));
    const localInput = screen.getByPlaceholderText(/\/path\/to/) as HTMLInputElement;
    expect(localInput.value).toBe('');
  });
});
