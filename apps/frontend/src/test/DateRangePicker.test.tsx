import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import dayjs from 'dayjs';
import { renderWithProviders } from './helpers';
import DateRangePicker from '../components/DateRangePicker';

const today = dayjs().format('YYYY-MM-DD');
const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
const weekAgo = dayjs().subtract(6, 'day').format('YYYY-MM-DD');

describe('DateRangePicker', () => {
  it('renders preset buttons and date inputs', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DateRangePicker value={{ from: weekAgo, to: today }} onChange={onChange} />,
    );

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('Month')).toBeInTheDocument();
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });

  it('highlights active "7 days" preset', () => {
    renderWithProviders(
      <DateRangePicker
        value={{ from: weekAgo, to: today }}
        onChange={vi.fn()}
      />,
    );

    const last7Btn = screen.getByText('7 days');
    expect(last7Btn.className).toContain('date-preset-active');
  });

  it('calls onChange with today preset', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DateRangePicker value={{ from: weekAgo, to: today }} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText('Today'));
    expect(onChange).toHaveBeenCalledWith({ from: today, to: today });
  });

  it('calls onChange with yesterday preset', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DateRangePicker value={{ from: weekAgo, to: today }} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText('Yesterday'));
    expect(onChange).toHaveBeenCalledWith({ from: yesterday, to: yesterday });
  });

  it('updates from date via input', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DateRangePicker value={{ from: '2025-03-01', to: '2025-03-15' }} onChange={onChange} />,
    );

    const inputs = screen.getAllByDisplayValue(/2025/);
    fireEvent.change(inputs[0], { target: { value: '2025-03-05' } });
    expect(onChange).toHaveBeenCalledWith({ from: '2025-03-05', to: '2025-03-15' });
  });

  it('ignores empty date value (does not call onChange)', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DateRangePicker value={{ from: '2025-03-01', to: '2025-03-15' }} onChange={onChange} />,
    );

    const inputs = screen.getAllByDisplayValue(/2025/);
    fireEvent.change(inputs[1], { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
