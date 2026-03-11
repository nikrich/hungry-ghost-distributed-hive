import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActivityFeed } from '../components/ActivityFeed';
import { AgentStatus } from '../components/AgentStatus';
import { EscalationPanel } from '../components/EscalationPanel';
import { StoryList } from '../components/StoryList';
import { useApi } from '../hooks/useApi';
import { type ConnectionStatus, useRunUpdates } from '../hooks/useRunUpdates';
import { useRunStore } from '../stores/runStore';
import type { Agent, Escalation, LogEntry, Run, Story } from '../types';

const connectionStatusLabel: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
};

const connectionStatusColor: Record<ConnectionStatus, string> = {
  connecting: 'text-yellow-600',
  connected: 'text-green-600',
  disconnected: 'text-red-600',
  reconnecting: 'text-yellow-600',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(startIso: string, endIso: string): string {
  const diff = new Date(endIso).getTime() - new Date(startIso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const {
    activeRun,
    stories,
    agents,
    logs,
    escalations,
    setActiveRun,
    setStories,
    setAgents,
    setLogs,
    setEscalations,
  } = useRunStore();
  const { get, post, del } = useApi();
  const { status: wsStatus } = useRunUpdates(id ?? null);
  const [cancelling, setCancelling] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function fetchRunData() {
      try {
        const [run, storiesData, agentsData, logsData] = await Promise.all([
          get<Run>(`/runs/${id}`),
          get<Story[]>(`/runs/${id}/stories`),
          get<Agent[]>(`/runs/${id}/agents`),
          get<LogEntry[]>(`/runs/${id}/logs`),
        ]);
        if (cancelled) return;
        setActiveRun(run);
        setStories(storiesData);
        setAgents(agentsData);
        setLogs(logsData);
        setFetchError(null);
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          setFetchError('Failed to load run data');
        }
      }
    }

    fetchRunData();
    return () => {
      cancelled = true;
    };
  }, [id, get, setActiveRun, setStories, setAgents, setLogs]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function fetchEscalations() {
      try {
        const data = await get<Escalation[]>(`/runs/${id}/escalations`);
        if (!cancelled) setEscalations(data);
      } catch {
        // Escalations endpoint may not exist yet
      }
    }

    fetchEscalations();
    return () => {
      cancelled = true;
    };
  }, [id, get, setEscalations]);

  const handleCancel = useCallback(async () => {
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await del(`/runs/${id}`);
      setActiveRun({ ...activeRun!, status: 'cancelled' });
    } catch {
      // Error handled by useApi
    } finally {
      setCancelling(false);
    }
  }, [id, cancelling, del, activeRun, setActiveRun]);

  const handleReply = useCallback(
    async (escalationId: string, storyId: string, message: string) => {
      if (!id) return;
      await post(`/runs/${id}/message`, {
        message,
        sender: 'user',
        escalationId,
        storyId,
      });
    },
    [id, post]
  );

  if (fetchError) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Link to="/" className="text-hive-600 hover:text-hive-700">
            &larr; Back
          </Link>
        </div>
        <p className="text-red-600">{fetchError}</p>
      </div>
    );
  }

  if (!activeRun || activeRun.id !== id) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Link to="/" className="text-hive-600 hover:text-hive-700">
            &larr; Back
          </Link>
        </div>
        <p className="text-gray-500">Loading run {id}...</p>
      </div>
    );
  }

  const doneCount = stories.filter(s => s.status === 'done' || s.status === 'merged').length;
  const isRunning = activeRun.status === 'running';
  const connectionLabel = connectionStatusLabel[wsStatus.current];
  const connectionColor = connectionStatusColor[wsStatus.current];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-hive-600 hover:text-hive-700">
            &larr; Back
          </Link>
          <h1 className="text-xl font-bold">{activeRun.title}</h1>
          <span className={`text-xs font-medium ${connectionColor}`}>{connectionLabel}</span>
        </div>
        {isRunning && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="px-4 py-2 text-red-600 border border-red-300 rounded-md hover:bg-red-50 text-sm font-medium disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-4 mb-6 text-sm text-gray-600">
        <span>
          {doneCount}/{stories.length} stories
        </span>
        {activeRun.startedAt && isRunning && <span>Started {timeAgo(activeRun.startedAt)}</span>}
        {activeRun.startedAt && activeRun.completedAt && (
          <span>Duration: {formatDuration(activeRun.startedAt, activeRun.completedAt)}</span>
        )}
        {isRunning && activeRun.estimatedCost != null && (
          <span>~${activeRun.estimatedCost.toFixed(2)} est.</span>
        )}
        {activeRun.actualCost != null && <span>Cost: ${activeRun.actualCost.toFixed(2)}</span>}
        {!isRunning && (
          <span className="capitalize font-medium text-gray-700">{activeRun.status}</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <StoryList stories={stories} />
          <AgentStatus agents={agents} />
        </div>

        <div className="lg:col-span-2 space-y-6">
          <ActivityFeed logs={logs} />
          <EscalationPanel escalations={escalations} onReply={handleReply} />
        </div>
      </div>
    </div>
  );
}
