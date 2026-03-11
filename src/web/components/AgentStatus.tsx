import type { Agent } from '../types';

const agentStatusColors: Record<string, string> = {
  working: 'bg-green-500',
  done: 'bg-green-500',
  waiting: 'bg-yellow-500',
  idle: 'bg-gray-300',
  error: 'bg-red-500',
};

interface AgentStatusProps {
  agents: Agent[];
}

export function AgentStatus({ agents }: AgentStatusProps) {
  return (
    <section className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="font-semibold mb-3">Agents</h2>
      {agents.length === 0 ? (
        <p className="text-sm text-gray-500">No agents yet.</p>
      ) : (
        <ul className="space-y-2">
          {agents.map(agent => (
            <li key={agent.id} className="flex items-center gap-2 text-sm">
              <span
                className={`w-2 h-2 rounded-full ${agentStatusColors[agent.status] ?? 'bg-gray-300'}`}
              />
              <span className="text-gray-800">{agent.role}</span>
              <span className="text-gray-400">({agent.status})</span>
              {agent.currentStory && (
                <span className="text-gray-500 text-xs ml-1">{agent.currentStory}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
