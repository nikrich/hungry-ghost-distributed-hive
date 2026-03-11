// Licensed under the Hungry Ghost Hive License. See LICENSE.

import { statSync } from 'fs';
import type { Database } from 'sql.js';
import type { AgentRow, EscalationRow, PullRequestRow, StoryRow } from '../db/client.js';
import { getReadOnlyDatabase } from '../db/client.js';
import { getAllAgents } from '../db/queries/agents.js';
import { getAllEscalations } from '../db/queries/escalations.js';
import { getRecentLogs } from '../db/queries/logs.js';
import { getAllPullRequests } from '../db/queries/pull-requests.js';
import { getAllStories } from '../db/queries/stories.js';
import { DynamoClient, type StateItem } from './dynamo-client.js';
import { EventEmitter, type HiveDetailType, type HiveEventDetail } from './event-emitter.js';

export interface StateSyncConfig {
  runId: string;
  dbPath: string; // .hive/hive.db
  dynamoTable: string; // distributed-hive-state
  eventBusName: string; // distributed-hive-events
  pollIntervalMs: number; // 5000
  region?: string;
  endpoint?: string;
}

interface StateSnapshot {
  stories: Map<string, StoryRow>;
  agents: Map<string, AgentRow>;
  pullRequests: Map<string, PullRequestRow>;
  escalations: Map<string, EscalationRow>;
  lastLogId: number;
}

export class StateSyncAdapter {
  private config: StateSyncConfig;
  private dynamo: DynamoClient;
  private events: EventEmitter;
  private lastSnapshot: StateSnapshot;
  private lastMtime: number = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: StateSyncConfig, dynamo?: DynamoClient, events?: EventEmitter) {
    this.config = config;
    this.dynamo =
      dynamo ||
      new DynamoClient({
        tableName: config.dynamoTable,
        region: config.region,
        endpoint: config.endpoint,
      });
    this.events =
      events ||
      new EventEmitter({
        eventBusName: config.eventBusName,
        region: config.region,
        endpoint: config.endpoint,
      });
    this.lastSnapshot = {
      stories: new Map(),
      agents: new Map(),
      pullRequests: new Map(),
      escalations: new Map(),
      lastLogId: 0,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.poll().catch(err => {
        console.error('[state-sync] Poll error:', err);
      });
    }, this.config.pollIntervalMs);

    // Initial poll
    this.poll().catch(err => {
      console.error('[state-sync] Initial poll error:', err);
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    // Check if DB file has changed (mtime check)
    let currentMtime: number;
    try {
      currentMtime = statSync(this.config.dbPath).mtimeMs;
    } catch {
      // DB file doesn't exist yet, skip this poll
      return;
    }

    if (currentMtime === this.lastMtime) return;
    this.lastMtime = currentMtime;

    // Open a read-only snapshot of the database
    const hiveDir = this.config.dbPath.replace(/\/hive\.db$/, '');
    const dbClient = await getReadOnlyDatabase(hiveDir);

    try {
      await this.syncState(dbClient.db);
    } finally {
      dbClient.close();
    }
  }

  async syncState(db: Database): Promise<void> {
    const dynamoItems: StateItem[] = [];
    const eventBatch: Array<{
      detailType: HiveDetailType;
      detail: HiveEventDetail;
    }> = [];

    // Sync stories
    const stories = getAllStories(db);
    for (const story of stories) {
      const existing = this.lastSnapshot.stories.get(story.id);
      if (!existing || this.hasChanged(existing, story)) {
        dynamoItems.push(
          DynamoClient.createStateItem(
            this.config.runId,
            `STORY#${story.id}`,
            'story',
            story as unknown as Record<string, unknown>
          )
        );
        eventBatch.push({
          detailType: 'story_update',
          detail: {
            runId: this.config.runId,
            entityType: 'story',
            entityId: story.id,
            status: story.status,
            data: story as unknown as Record<string, unknown>,
          },
        });
      }
    }
    this.lastSnapshot.stories = new Map(stories.map(s => [s.id, s]));

    // Sync agents
    const agents = getAllAgents(db);
    for (const agent of agents) {
      const existing = this.lastSnapshot.agents.get(agent.id);
      if (!existing || this.hasChanged(existing, agent)) {
        dynamoItems.push(
          DynamoClient.createStateItem(
            this.config.runId,
            `AGENT#${agent.id}`,
            'agent',
            agent as unknown as Record<string, unknown>
          )
        );
        eventBatch.push({
          detailType: 'agent_update',
          detail: {
            runId: this.config.runId,
            entityType: 'agent',
            entityId: agent.id,
            status: agent.status,
            data: agent as unknown as Record<string, unknown>,
          },
        });
      }
    }
    this.lastSnapshot.agents = new Map(agents.map(a => [a.id, a]));

    // Sync pull requests
    const pullRequests = getAllPullRequests(db);
    for (const pr of pullRequests) {
      const existing = this.lastSnapshot.pullRequests.get(pr.id);
      if (!existing || this.hasChanged(existing, pr)) {
        dynamoItems.push(
          DynamoClient.createStateItem(
            this.config.runId,
            `PR#${pr.id}`,
            'pr',
            pr as unknown as Record<string, unknown>
          )
        );
        eventBatch.push({
          detailType: 'pr_created',
          detail: {
            runId: this.config.runId,
            entityType: 'pr',
            entityId: pr.id,
            status: pr.status,
            data: pr as unknown as Record<string, unknown>,
          },
        });
      }
    }
    this.lastSnapshot.pullRequests = new Map(pullRequests.map(p => [p.id, p]));

    // Sync escalations
    const escalations = getAllEscalations(db);
    for (const esc of escalations) {
      const existing = this.lastSnapshot.escalations.get(esc.id);
      if (!existing || this.hasChanged(existing, esc)) {
        dynamoItems.push(
          DynamoClient.createStateItem(
            this.config.runId,
            `ESCALATION#${esc.id}`,
            'escalation',
            esc as unknown as Record<string, unknown>
          )
        );
        eventBatch.push({
          detailType: 'escalation',
          detail: {
            runId: this.config.runId,
            entityType: 'escalation',
            entityId: esc.id,
            status: esc.status,
            data: esc as unknown as Record<string, unknown>,
          },
        });
      }
    }
    this.lastSnapshot.escalations = new Map(escalations.map(e => [e.id, e]));

    // Sync new logs (only new entries since last sync)
    const logs = getRecentLogs(db, 200);
    const newLogs = logs.filter(log => log.id > this.lastSnapshot.lastLogId);
    for (const log of newLogs) {
      dynamoItems.push(
        DynamoClient.createStateItem(
          this.config.runId,
          `LOG#${log.timestamp}#${log.id}`,
          'log',
          log as unknown as Record<string, unknown>
        )
      );
      eventBatch.push({
        detailType: 'log_entry',
        detail: {
          runId: this.config.runId,
          entityType: 'log',
          entityId: String(log.id),
          status: log.event_type,
          data: log as unknown as Record<string, unknown>,
        },
      });
    }
    if (newLogs.length > 0) {
      this.lastSnapshot.lastLogId = Math.max(...newLogs.map(l => l.id));
    }

    // Write all changes to DynamoDB
    if (dynamoItems.length > 0) {
      await this.dynamo.batchWriteItems(dynamoItems);
    }

    // Emit events
    if (eventBatch.length > 0) {
      await this.events.emitBatch(eventBatch);
    }

    // Check for run completion
    if (this.isRunComplete(stories)) {
      await this.handleRunComplete(stories);
    }
  }

  isRunComplete(stories: StoryRow[]): boolean {
    if (stories.length === 0) return false;

    const terminalStatuses = ['merged', 'cancelled', 'rejected'];
    return stories.every(s => terminalStatuses.includes(s.status));
  }

  private async handleRunComplete(stories: StoryRow[]): Promise<void> {
    // Write final meta record
    await this.dynamo.batchWriteItems([
      DynamoClient.createStateItem(this.config.runId, 'META', 'meta', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        totalStories: stories.length,
        mergedStories: stories.filter(s => s.status === 'merged').length,
      }),
    ]);

    // Emit run_complete event
    await this.events.emit('run_complete', {
      runId: this.config.runId,
      entityType: 'run',
      entityId: this.config.runId,
      status: 'completed',
      data: {
        totalStories: stories.length,
        mergedStories: stories.filter(s => s.status === 'merged').length,
        completedAt: new Date().toISOString(),
      },
    });

    this.stop();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hasChanged(existing: any, current: any): boolean {
    // Compare updated_at timestamps if available, fall back to JSON comparison
    if (existing.updated_at && current.updated_at) {
      return existing.updated_at !== current.updated_at;
    }
    return JSON.stringify(existing) !== JSON.stringify(current);
  }
}

// CLI entrypoint for running as a standalone process
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string => {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) {
      throw new Error(`Missing required argument: --${name}`);
    }
    return args[idx + 1];
  };

  const config: StateSyncConfig = {
    runId: getArg('run-id'),
    dbPath: getArg('db-path') || '/workspace/.hive/hive.db',
    dynamoTable: getArg('table'),
    eventBusName: getArg('event-bus'),
    pollIntervalMs: 5000,
  };

  const adapter = new StateSyncAdapter(config);
  adapter.start();

  console.log(`[state-sync] Started for run ${config.runId}`);

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[state-sync] Received SIGTERM, stopping...');
    adapter.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[state-sync] Received SIGINT, stopping...');
    adapter.stop();
    process.exit(0);
  });
}

// Only run main when executed directly
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('state-sync.js') || process.argv[1].endsWith('state-sync.ts'));

if (isMainModule) {
  main().catch(err => {
    console.error('[state-sync] Fatal error:', err);
    process.exit(1);
  });
}

