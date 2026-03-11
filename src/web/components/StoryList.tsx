import type { Story } from '../types';

const statusColors: Record<string, string> = {
  done: 'text-green-600',
  merged: 'text-green-600',
  in_progress: 'text-blue-600',
  review: 'text-yellow-600',
  todo: 'text-gray-400',
};

const statusIcons: Record<string, string> = {
  done: '\u2713',
  merged: '\u2713',
  in_progress: '\u25CF',
  review: '\u25CF',
  todo: '\u25CB',
};

interface StoryListProps {
  stories: Story[];
}

export function StoryList({ stories }: StoryListProps) {
  return (
    <section className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="font-semibold mb-3">Stories</h2>
      {stories.length === 0 ? (
        <p className="text-sm text-gray-500">No stories yet.</p>
      ) : (
        <ul className="space-y-2">
          {stories.map(story => (
            <li key={story.id} className="text-sm">
              <div className="flex items-start gap-2">
                <span className={statusColors[story.status] ?? 'text-gray-400'}>
                  {statusIcons[story.status] ?? '\u25CB'}
                </span>
                <div>
                  <span className="text-gray-600">{story.id}</span>
                  <span className="text-gray-400 ml-1">({story.points}pts)</span>
                  <p className="text-gray-800">{story.title}</p>
                  {story.assignee && (
                    <p className="text-gray-500 text-xs">Agent: {story.assignee}</p>
                  )}
                  {story.prUrl && (
                    <a
                      href={story.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-hive-600 text-xs hover:underline"
                    >
                      PR #{story.prNumber}
                    </a>
                  )}
                  {story.dependencies && story.dependencies.length > 0 && (
                    <p className="text-gray-400 text-xs">
                      Depends on: {story.dependencies.join(', ')}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
