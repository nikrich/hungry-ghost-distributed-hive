import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RunCard } from '../components/RunCard';
import { useRunStore } from '../stores/runStore';
import type { Run } from '../types';

export function Dashboard() {
  const runs = useRunStore(s => s.runs);
  const setRuns = useRunStore(s => s.setRuns);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/runs')
      .then(res => {
        if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
        return res.json() as Promise<Run[]>;
      })
      .then(data => {
        setRuns(data);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [setRuns]);

  const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'pending');
  const completedRuns = runs.filter(
    r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
  );

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link
          to="/submit"
          className="px-4 py-2 bg-hive-600 text-white rounded-md hover:bg-hive-700 transition-colors text-sm font-medium"
        >
          + New Run
        </Link>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading runs...</p>}
      {error && <p className="text-red-500 text-sm">{error}</p>}

      <section>
        <h2 className="text-lg font-semibold mb-3">Active Runs</h2>
        {activeRuns.length === 0 ? (
          <p className="text-gray-500 text-sm">No active runs.</p>
        ) : (
          <div className="space-y-3">
            {activeRuns.map(run => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent Completed</h2>
        {completedRuns.length === 0 ? (
          <p className="text-gray-500 text-sm">No completed runs yet.</p>
        ) : (
          <div className="space-y-3">
            {completedRuns.map(run => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
