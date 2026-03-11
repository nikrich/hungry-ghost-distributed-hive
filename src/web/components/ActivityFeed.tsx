import { useEffect, useRef } from 'react';
import type { LogEntry } from '../types';

interface ActivityFeedProps {
  logs: LogEntry[];
}

export function ActivityFeed({ logs }: ActivityFeedProps) {
  const feedRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="font-semibold mb-3">Activity Feed</h2>
      {logs.length === 0 ? (
        <p className="text-sm text-gray-500">No activity yet.</p>
      ) : (
        <ul ref={feedRef} className="space-y-2 max-h-96 overflow-y-auto">
          {[...logs].reverse().map(log => (
            <li key={log.id} className="text-sm flex gap-3">
              <span className="text-gray-400 whitespace-nowrap">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className="text-gray-500 text-xs whitespace-nowrap">{log.source}</span>
              <span
                className={
                  log.level === 'error'
                    ? 'text-red-600'
                    : log.level === 'warn'
                      ? 'text-yellow-600'
                      : 'text-gray-700'
                }
              >
                {log.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
