import { useEffect, useRef, useState } from 'react';
import { useRunStore } from '../stores/runStore';
import type { Agent, Escalation, LogEntry, Story } from '../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'wss://api.distributed-hive.com/ws';
const MAX_RECONNECT_DELAY = 30_000;

interface WsMessage {
  type: string;
  data: unknown;
}

export function useRunUpdates(runId: string | null) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1_000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  const { updateStory, updateAgent, addLog, addEscalation, setActiveRun } = useRunStore.getState();

  useEffect(() => {
    isMounted.current = true;

    if (!runId) {
      setConnectionStatus('disconnected');
      return;
    }

    function connect() {
      if (!isMounted.current) return;
      setConnectionStatus('connecting');

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted.current) return;
        setConnectionStatus('connected');
        reconnectDelay.current = 1_000;
        ws.send(JSON.stringify({ action: 'subscribe', runId }));
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!isMounted.current) return;
        try {
          const msg: WsMessage = JSON.parse(event.data as string);
          const store = useRunStore.getState();

          switch (msg.type) {
            case 'story_update':
              store.updateStory(msg.data as Story);
              break;
            case 'agent_update':
              store.updateAgent(msg.data as Agent);
              break;
            case 'log_entry':
              store.addLog(msg.data as LogEntry);
              break;
            case 'escalation':
              store.addEscalation(msg.data as Escalation);
              break;
            case 'pr_created': {
              const pr = msg.data as { storyId: string; prNumber: number; prUrl: string };
              const story = store.stories.find(s => s.id === pr.storyId);
              if (story) {
                store.updateStory({ ...story, prNumber: pr.prNumber, prUrl: pr.prUrl });
              }
              break;
            }
            case 'run_complete':
              if (store.activeRun) {
                store.setActiveRun({ ...store.activeRun, status: 'completed' });
              }
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!isMounted.current) return;
        setConnectionStatus('reconnecting');
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_DELAY);
          connect();
        }, reconnectDelay.current);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      isMounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      setConnectionStatus('disconnected');
    };
  }, [runId]);

  const disconnect = () => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }
    setConnectionStatus('disconnected');
  };

  return {
    status: { current: connectionStatus },
    disconnect,
  };
}
