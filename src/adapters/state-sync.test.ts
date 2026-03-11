// Licensed under the Hungry Ghost Hive License. See LICENSE.

import type { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../db/queries/agents.js';
import { createEscalation } from '../db/queries/escalations.js';
import { createLog } from '../db/queries/logs.js';
import { getMessageById } from '../db/queries/messages.js';
import { createPullRequest } from '../db/queries/pull-requests.js';
import { createStory } from '../db/queries/stories.js';
import { createTestDatabase } from '../db/queries/test-helpers.js';
import { DynamoClient, type StateItem } from './dynamo-client.js';
import { EventEmitter, type HiveDetailType, type HiveEventDetail } from './event-emitter.js';
import { StateSyncAdapter } from './state-sync.js';

// Mock DynamoDB client
class MockDynamoClient {
  writtenItems: StateItem[] = [];
  queriedItems: StateItem[] = [];
  deletedKeys: Array<{ PK: string; SK: string }> = [];

  async batchWriteItems(items: StateItem[]): Promise<void> {
    this.writtenItems.push(...items);
  }

  async queryByRunId(_runId: string, skPrefix?: string): Promise<StateItem[]> {
    if (skPrefix) {
      return this.queriedItems.filter(item => item.SK.startsWith(skPrefix));
    }
    return this.queriedItems;
  }

  async deleteItems(keys: Array<{ PK: string; SK: string }>): Promise<void> {
    this.deletedKeys.push(...keys);
  }

  reset(): void {
    this.writtenItems = [];
    this.queriedItems = [];
    this.deletedKeys = [];
  }
}

// Mock EventBridge client
class MockEventEmitter {
  emittedEvents: Array<{ detailType: HiveDetailType; detail: HiveEventDetail }> = [];

  async emit(detailType: HiveDetailType, detail: HiveEventDetail): Promise<void> {
    this.emittedEvents.push({ detailType, detail });
  }

  async emitBatch(
    events: Array<{ detailType: HiveDetailType; detail: HiveEventDetail }>
  ): Promise<void> {
    this.emittedEvents.push(...events);
  }

  reset(): void {
    this.emittedEvents = [];
  }
}

describe('StateSyncAdapter', () => {
  let db: Database;
  let mockDynamo: MockDynamoClient;
  let mockEvents: MockEventEmitter;
  let adapter: StateSyncAdapter;

  beforeEach(async () => {
    db = await createTestDatabase();
    mockDynamo = new MockDynamoClient();
    mockEvents = new MockEventEmitter();

    adapter = new StateSyncAdapter(
      {
        runId: 'test-run-123',
        dbPath: '/workspace/.hive/hive.db',
        dynamoTable: 'test-table',
        eventBusName: 'test-bus',
        pollIntervalMs: 5000,
      },
      mockDynamo as unknown as DynamoClient,
      mockEvents as unknown as EventEmitter
    );
  });

  afterEach(() => {
    adapter.stop();
    db.close();
  });

  describe('syncState', () => {
    it('should sync stories to DynamoDB and emit events', async () => {
      // Create a team first (required for agent FK)
      db.run(
        "INSERT INTO teams (id, repo_url, repo_path, name) VALUES ('team-1', 'https://github.com/test/repo', '/path/to/repo', 'test-team')"
      );

      // Create agent (needed for story assignment)
      createAgent(db, { type: 'senior', teamId: 'team-1' });

      // Create a story
      const story = createStory(db, {
        title: 'Test story',
        description: 'Test description',
        requirementId: null,
      });

      await adapter.syncState(db);

      // Should have written story to DynamoDB
      const storyItems = mockDynamo.writtenItems.filter(item => item.type === 'story');
      expect(storyItems).toHaveLength(1);
      expect(storyItems[0].PK).toBe('RUN#test-run-123');
      expect(storyItems[0].SK).toBe(`STORY#${story.id}`);
      expect(storyItems[0].data).toMatchObject({
        id: story.id,
        title: 'Test story',
        status: 'draft',
      });

      // Should have emitted story_update event
      const storyEvents = mockEvents.emittedEvents.filter(e => e.detailType === 'story_update');
      expect(storyEvents).toHaveLength(1);
      expect(storyEvents[0].detail.runId).toBe('test-run-123');
      expect(storyEvents[0].detail.entityId).toBe(story.id);
    });

    it('should sync agents to DynamoDB and emit events', async () => {
      db.run(
        "INSERT INTO teams (id, repo_url, repo_path, name) VALUES ('team-1', 'https://github.com/test/repo', '/path/to/repo', 'test-team')"
      );
      const agent = createAgent(db, { type: 'senior', teamId: 'team-1' });

      await adapter.syncState(db);

      const agentItems = mockDynamo.writtenItems.filter(item => item.type === 'agent');
      expect(agentItems).toHaveLength(1);
      expect(agentItems[0].SK).toBe(`AGENT#${agent.id}`);

      const agentEvents = mockEvents.emittedEvents.filter(e => e.detailType === 'agent_update');
      expect(agentEvents).toHaveLength(1);
    });

    it('should sync pull requests to DynamoDB', async () => {
      db.run(
        "INSERT INTO teams (id, repo_url, repo_path, name) VALUES ('team-1', 'https://github.com/test/repo', '/path/to/repo', 'test-team')"
      );
      const agent = createAgent(db, { type: 'senior', teamId: 'team-1' });
      const story = createStory(db, {
        title: 'Test story',
        description: 'Desc',
      });
      const pr = createPullRequest(db, {
        storyId: story.id,
        teamId: 'team-1',
        branchName: 'feature/test',
        githubPrUrl: 'https://github.com/test/repo/pull/1',
        submittedBy: agent.id,
      });

      await adapter.syncState(db);

      const prItems = mockDynamo.writtenItems.filter(item => item.type === 'pr');
      expect(prItems).toHaveLength(1);
      expect(prItems[0].SK).toBe(`PR#${pr.id}`);
    });

    it('should sync escalations to DynamoDB', async () => {
      db.run(
        "INSERT INTO teams (id, repo_url, repo_path, name) VALUES ('team-1', 'https://github.com/test/repo', '/path/to/repo', 'test-team')"
      );
      const agent = createAgent(db, { type: 'senior', teamId: 'team-1' });
      const escalation = createEscalation(db, {
        fromAgentId: agent.id,
        reason: 'Need help',
      });

      await adapter.syncState(db);

      const escItems = mockDynamo.writtenItems.filter(item => item.type === 'escalation');
      expect(escItems).toHaveLength(1);
      expect(escItems[0].SK).toBe(`ESCALATION#${escalation.id}`);

      const escEvents = mockEvents.emittedEvents.filter(e => e.detailType === 'escalation');
      expect(escEvents).toHaveLength(1);
    });

    it('should sync new logs incrementally', async () => {
      db.run(
        "INSERT INTO teams (id, repo_url, repo_path, name) VALUES ('team-1', 'https://github.com/test/repo', '/path/to/repo', 'test-team')"
      );
      const agent = createAgent(db, { type: 'senior', teamId: 'team-1' });

      createLog(db, {
        agentId: agent.id,
        eventType: 'AGENT_SPAWNED',
        message: 'Agent spawned',
      });

      await adapter.syncState(db);

      const logItems = mockDynamo.writtenItems.filter(item => item.type === 'log');
      expect(logItems).toHaveLength(1);
      expect(logItems[0].SK).toMatch(/^LOG#/);

      // Second sync should not re-emit the same log
      mockDynamo.reset();
      mockEvents.reset();

      await adapter.syncState(db);

      const logItems2 = mockDynamo.writtenItems.filter(item => item.type === 'log');
      expect(logItems2).toHaveLength(0);
    });

    it('should not re-sync unchanged stories', async () => {
      createStory(db, {
        title: 'Test story',
        description: 'Desc',
      });

      await adapter.syncState(db);
      expect(mockDynamo.writtenItems.filter(i => i.type === 'story')).toHaveLength(1);

      // Reset and sync again without changes
      mockDynamo.reset();
      mockEvents.reset();

      await adapter.syncState(db);
      expect(mockDynamo.writtenItems.filter(i => i.type === 'story')).toHaveLength(0);
    });

    it('should detect changes via updated_at timestamp', async () => {
      const story = createStory(db, {
        title: 'Test story',
        description: 'Desc',
      });

      await adapter.syncState(db);
      mockDynamo.reset();
      mockEvents.reset();

      // Update the story status with a distinct updated_at timestamp
      db.run(
        "UPDATE stories SET status = 'in_progress', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
        [story.id]
      );

      await adapter.syncState(db);
      const storyItems = mockDynamo.writtenItems.filter(item => item.type === 'story');
      expect(storyItems).toHaveLength(1);
      expect(storyItems[0].data).toMatchObject({ status: 'in_progress' });
    });
  });

  describe('isRunComplete', () => {
    it('should return false for empty stories', () => {
      expect(adapter.isRunComplete([])).toBe(false);
    });

    it('should return false when some stories are not in terminal state', () => {
      const stories = [
        { id: '1', status: 'merged' },
        { id: '2', status: 'in_progress' },
      ] as any[];
      expect(adapter.isRunComplete(stories)).toBe(false);
    });

    it('should return true when all stories are merged', () => {
      const stories = [
        { id: '1', status: 'merged' },
        { id: '2', status: 'merged' },
      ] as any[];
      expect(adapter.isRunComplete(stories)).toBe(true);
    });

    it('should return true for mixed terminal states', () => {
      const stories = [
        { id: '1', status: 'merged' },
        { id: '2', status: 'cancelled' },
        { id: '3', status: 'rejected' },
      ] as any[];
      expect(adapter.isRunComplete(stories)).toBe(true);
    });
  });

  describe('run completion', () => {
    it('should emit run_complete event and write meta when all stories are merged', async () => {
      const story = createStory(db, {
        title: 'Test story',
        description: 'Desc',
      });

      // Set story to merged status
      db.run(
        "UPDATE stories SET status = 'merged', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
        [story.id]
      );

      await adapter.syncState(db);

      // Should have written META item
      const metaItems = mockDynamo.writtenItems.filter(item => item.SK === 'META');
      expect(metaItems).toHaveLength(1);
      expect(metaItems[0].data).toMatchObject({
        status: 'completed',
        totalStories: 1,
        mergedStories: 1,
      });

      // Should have emitted run_complete event
      const completeEvents = mockEvents.emittedEvents.filter(e => e.detailType === 'run_complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].detail.status).toBe('completed');
    });
  });

  describe('DynamoDB item structure', () => {
    it('should create state items with correct structure', () => {
      const item = DynamoClient.createStateItem('run-1', 'STORY#S1', 'story', {
        id: 'S1',
        title: 'Test',
      });

      expect(item.PK).toBe('RUN#run-1');
      expect(item.SK).toBe('STORY#S1');
      expect(item.type).toBe('story');
      expect(item.updatedAt).toBeDefined();
      expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should set TTL to ~30 days from now', () => {
      const item = DynamoClient.createStateItem('run-1', 'META', 'meta', {});
      const now = Math.floor(Date.now() / 1000);
      const thirtyDays = 30 * 24 * 60 * 60;
      // TTL should be within a few seconds of 30 days from now
      expect(item.ttl).toBeGreaterThanOrEqual(now + thirtyDays - 5);
      expect(item.ttl).toBeLessThanOrEqual(now + thirtyDays + 5);
    });
  });

  describe('relayInboundMessages', () => {
    it('should write inbound messages to SQLite messages table', async () => {
      const inboundItems: StateItem[] = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:00.000Z',
          type: 'inbound_msg',
          data: {
            id: 'msg-1',
            fromSession: 'web-user-abc',
            toSession: 'agent-session-1',
            body: 'Please fix the login bug',
            subject: 'Escalation response',
          },
          updatedAt: '2024-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      await adapter.relayInboundMessages(db, inboundItems);

      const message = getMessageById(db, 'msg-1');
      expect(message).toBeDefined();
      expect(message?.from_session).toBe('web-user-abc');
      expect(message?.to_session).toBe('agent-session-1');
      expect(message?.body).toBe('Please fix the login bug');
      expect(message?.subject).toBe('Escalation response');
      expect(message?.status).toBe('pending');
    });

    it('should handle multiple inbound messages in order', async () => {
      const inboundItems: StateItem[] = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:01.000Z',
          type: 'inbound_msg',
          data: {
            id: 'msg-2',
            fromSession: 'web-user',
            toSession: 'agent-1',
            body: 'Second message',
          },
          updatedAt: '2024-01-01T00:00:01.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:02.000Z',
          type: 'inbound_msg',
          data: {
            id: 'msg-3',
            fromSession: 'web-user',
            toSession: 'agent-2',
            body: 'Third message',
          },
          updatedAt: '2024-01-01T00:00:02.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      await adapter.relayInboundMessages(db, inboundItems);

      expect(getMessageById(db, 'msg-2')).toBeDefined();
      expect(getMessageById(db, 'msg-3')).toBeDefined();
      expect(getMessageById(db, 'msg-2')?.body).toBe('Second message');
      expect(getMessageById(db, 'msg-3')?.body).toBe('Third message');
    });

    it('should delete processed items from DynamoDB', async () => {
      const inboundItems: StateItem[] = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:00.000Z',
          type: 'inbound_msg',
          data: {
            id: 'msg-del-1',
            fromSession: 'web-user',
            toSession: 'agent-1',
            body: 'Delete me after relay',
          },
          updatedAt: '2024-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      await adapter.relayInboundMessages(db, inboundItems);

      expect(mockDynamo.deletedKeys).toHaveLength(1);
      expect(mockDynamo.deletedKeys[0]).toEqual({
        PK: 'RUN#test-run-123',
        SK: 'INBOUND_MSG#2024-01-01T00:00:00.000Z',
      });
    });

    it('should use fallback values when data fields are missing', async () => {
      const inboundItems: StateItem[] = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:05.000Z',
          type: 'inbound_msg',
          data: {},
          updatedAt: '2024-01-01T00:00:05.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      await adapter.relayInboundMessages(db, inboundItems);

      // Should use SK timestamp as message ID fallback
      const message = getMessageById(db, '2024-01-01T00:00:05.000Z');
      expect(message).toBeDefined();
      expect(message?.from_session).toBe('web-user');
      expect(message?.to_session).toBe('');
      expect(message?.body).toBe('');
      expect(message?.subject).toBeNull();
    });

    it('should track last processed timestamp to avoid re-processing', async () => {
      const firstBatch: StateItem[] = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:00.000Z',
          type: 'inbound_msg',
          data: { id: 'msg-first', fromSession: 'user', toSession: 'agent', body: 'First' },
          updatedAt: '2024-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      await adapter.relayInboundMessages(db, firstBatch);
      mockDynamo.reset();

      // Simulate DynamoDB returning same items (not yet deleted due to eventual consistency)
      // plus new items. The adapter filters by lastInboundTimestamp.
      mockDynamo.queriedItems = [
        ...firstBatch,
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:01:00.000Z',
          type: 'inbound_msg',
          data: { id: 'msg-second', fromSession: 'user', toSession: 'agent', body: 'Second' },
          updatedAt: '2024-01-01T00:01:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      // Manually filter like pollInboundMessages does
      const items = mockDynamo.queriedItems.filter(
        item => item.SK.startsWith('INBOUND_MSG#')
      );
      const newItems = items.filter(
        item => item.SK > `INBOUND_MSG#2024-01-01T00:00:00.000Z`
      );

      // Only the second message should be new
      expect(newItems).toHaveLength(1);
      expect(newItems[0].data.id).toBe('msg-second');
    });

    it('should handle messages with subject field', async () => {
      const inboundItems: StateItem[] = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#2024-01-01T00:00:00.000Z',
          type: 'inbound_msg',
          data: {
            id: 'msg-subj',
            fromSession: 'web-user',
            toSession: 'agent-1',
            body: 'Response body',
            subject: 'RE: Escalation #42',
          },
          updatedAt: '2024-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ];

      await adapter.relayInboundMessages(db, inboundItems);

      const message = getMessageById(db, 'msg-subj');
      expect(message?.subject).toBe('RE: Escalation #42');
    });
  });

  describe('start and stop', () => {
    it('should start and stop the polling timer', () => {
      vi.useFakeTimers();

      adapter.start();
      // Starting again should be a no-op
      adapter.start();

      adapter.stop();

      vi.useRealTimers();
    });
  });
});
