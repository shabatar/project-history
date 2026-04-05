import { useEffect, useRef } from 'react';
import dayjs from 'dayjs';

export interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'step';
}

interface Props {
  entries: LogEntry[];
  visible: boolean;
}

export function createLogEntry(
  message: string,
  type: LogEntry['type'] = 'info',
): LogEntry {
  return { time: dayjs().format('HH:mm:ss'), message, type };
}

export default function GenerationLog({ entries, visible }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  if (!visible || entries.length === 0) return null;

  return (
    <div className="generation-log">
      <div className="generation-log-header">
        <span className="generation-log-title">Generation Log</span>
        <span className="generation-log-count">{entries.length} events</span>
      </div>
      <div className="generation-log-body">
        {entries.map((entry, i) => (
          <div key={i} className={`generation-log-entry log-${entry.type}`}>
            <span className="log-time">{entry.time}</span>
            <span className="log-dot" />
            <span className="log-message">{entry.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
