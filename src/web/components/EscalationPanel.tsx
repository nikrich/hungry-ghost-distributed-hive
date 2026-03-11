import { useCallback, useState } from 'react';
import type { Escalation } from '../types';

interface EscalationPanelProps {
  escalations: Escalation[];
  onReply: (escalationId: string, storyId: string, message: string) => Promise<void>;
}

export function EscalationPanel({ escalations, onReply }: EscalationPanelProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyLoading, setReplyLoading] = useState(false);

  const handleReply = useCallback(
    async (escalationId: string, storyId: string) => {
      if (!replyText.trim() || replyLoading) return;
      setReplyLoading(true);
      try {
        await onReply(escalationId, storyId, replyText.trim());
        setReplyText('');
        setReplyingTo(null);
      } finally {
        setReplyLoading(false);
      }
    },
    [replyText, replyLoading, onReply]
  );

  const unresolvedEscalations = escalations.filter(esc => !esc.resolved);

  if (unresolvedEscalations.length === 0) return null;

  return (
    <section className="bg-white rounded-lg border border-yellow-200 p-4">
      <h2 className="font-semibold mb-3">Escalations</h2>
      <ul className="space-y-3">
        {unresolvedEscalations.map(esc => (
          <li key={esc.id} className="text-sm">
            <div className="flex items-start gap-2">
              <span className="text-yellow-600 mt-0.5">!</span>
              <div className="flex-1">
                <span className="text-gray-600 font-medium">{esc.storyId}:</span>{' '}
                <span className="text-gray-800">{esc.message}</span>
                <div className="mt-1">
                  {replyingTo === esc.id ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleReply(esc.id, esc.storyId);
                        }}
                        placeholder="Type your reply…"
                        className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded"
                        autoFocus
                      />
                      <button
                        onClick={() => handleReply(esc.id, esc.storyId)}
                        disabled={replyLoading || !replyText.trim()}
                        className="px-2 py-1 text-xs bg-hive-600 text-white rounded hover:bg-hive-700 disabled:opacity-50"
                      >
                        {replyLoading ? 'Sending…' : 'Send'}
                      </button>
                      <button
                        onClick={() => {
                          setReplyingTo(null);
                          setReplyText('');
                        }}
                        className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setReplyingTo(esc.id)}
                      className="text-xs text-hive-600 hover:underline"
                    >
                      Reply
                    </button>
                  )}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
