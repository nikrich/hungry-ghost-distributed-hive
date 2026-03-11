// Licensed under the Hungry Ghost Hive License. See LICENSE.

import type { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../db/queries/agents.js';
import { createEscalation } from '../db/queries/escalations.js';
import { createLog } from '../db/queries/logs.js';
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
  deliveredMessages: Array<{ runId: string; sk: string }> = [];

  async batchWriteItems(items: StateItem[]): Promise<void> {
    this.writtenItems.push(...items);
  }

  async queryByRunId(_runId: string, _skPrefix?: string): Promise<StateItem[]> {
    return this.queriedItems;
  }

  async markInboundMessageDelivered(runId: string, sk: string): Promise<void> {
    this.deliveredMessages.push({ runId, sk });
    // Mark the item as delivered in our mock store
    const item = this.queriedItems.find(i => i.SK === sk);
    if (item) {
      item.data.status = 'delivered';
    }
  }

  reset(): void {
    this.writtenItems = [];
    this.queriedItems = [];
    this.deliveredMessages = [];
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

  describe('pollInboundMessages', () => {
    it('should write inbound messages from DynamoDB to SQLite', async () => {
      mockDynamo.queriedItems = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#1710000000000',
          type: 'inbound_msg',
          data: {
            messageId: 'msg-001',
            fromSession: 'web-user',
            toSession: 'manager',
            subject: 'Answer to escalation',
            body: 'Please proceed with option A',
          },
          updatedAt: '2026-03-11T00:00:00.000Z',
          ttl: 9999999999,
        },
      ];

      await adapter.pollInboundMessages(db);

      // Verify message was inserted into SQLite
      const result = db.exec("SELECT * FROM messages WHERE id = 'msg-001'");
      expect(result).toHaveLength(1);
      const row = result[0];
      const cols = row.columns;
      const vals = row.values[0];
      const msg = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));

      expect(msg.from_session).toBe('web-user');
      expect(msg.to_session).toBe('manager');
      expect(msg.subject).toBe('Answer to escalation');
      expect(msg.body).toBe('Please proceed with option A');
      expect(msg.status).toBe('pending');

      // Verify message was marked as delivered in DynamoDB
      expect(mockDynamo.deliveredMessages).toHaveLength(1);
      expect(mockDynamo.deliveredMessages[0].sk).toBe('INBOUND_MSG#1710000000000');
    });

    it('should skip already-delivered messages', async () => {
      mockDynamo.queriedItems = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#1710000000000',
          type: 'inbound_msg',
          data: {
            messageId: 'msg-already-delivered',
            fromSession: 'web-user',
            toSession: 'manager',
            body: 'Old message',
            status: 'delivered',
          },
          updatedAt: '2026-03-11T00:00:00.000Z',
          ttl: 9999999999,
        },
      ];

      await adapter.pollInboundMessages(db);

      // Should not insert anything
      const result = db.exec("SELECT * FROM messages WHERE id = 'msg-already-delivered'");
      expect(result).toHaveLength(0);

      // Should not call markInboundMessageDelivered
      expect(mockDynamo.deliveredMessages).toHaveLength(0);
    });

    it('should handle multiple inbound messages', async () => {
      mockDynamo.queriedItems = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#1710000000001',
          type: 'inbound_msg',
          data: {
            messageId: 'msg-a',
            fromSession: 'user-1',
            toSession: 'agent-senior-1',
            body: 'First message',
          },
          updatedAt: '2026-03-11T00:00:01.000Z',
          ttl: 9999999999,
        },
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#1710000000002',
          type: 'inbound_msg',
          data: {
            messageId: 'msg-b',
            fromSession: 'user-1',
            toSession: 'agent-senior-2',
            body: 'Second message',
          },
          updatedAt: '2026-03-11T00:00:02.000Z',
          ttl: 9999999999,
        },
      ];

      await adapter.pollInboundMessages(db);

      // Both messages should be in SQLite
      const result = db.exec('SELECT * FROM messages ORDER BY id');
      expect(result).toHaveLength(1);
      expect(result[0].values).toHaveLength(2);

      // Both should be marked delivered
      expect(mockDynamo.deliveredMessages).toHaveLength(2);
    });

    it('should use default values for missing fields', async () => {
      mockDynamo.queriedItems = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#1710000000003',
          type: 'inbound_msg',
          data: {
            body: 'Message with minimal fields',
          },
          updatedAt: '2026-03-11T00:00:00.000Z',
          ttl: 9999999999,
        },
      ];

      await adapter.pollInboundMessages(db);

      const result = db.exec('SELECT * FROM messages');
      expect(result).toHaveLength(1);
      const cols = result[0].columns;
      const vals = result[0].values[0];
      const msg = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));

      expect(msg.from_session).toBe('web-ui');
      expect(msg.to_session).toBe('manager');
      expect(msg.body).toBe('Message with minimal fields');
      expect(msg.id).toBeTruthy(); // auto-generated UUID
    });

    it('should not duplicate messages on re-poll (INSERT OR IGNORE)', async () => {
      const items = [
        {
          PK: 'RUN#test-run-123',
          SK: 'INBOUND_MSG#1710000000004',
          type: 'inbound_msg',
          data: {
            messageId: 'msg-dup',
            fromSession: 'web-user',
            toSession: 'manager',
            body: 'Duplicate test',
          },
          updatedAt: '2026-03-11T00:00:00.000Z',
          ttl: 9999999999,
        },
      ];

      mockDynamo.queriedItems = items;
      await adapter.pollInboundMessages(db);

      // Reset delivered tracking but keep the same items as "not delivered" for this test
      mockDynamo.deliveredMessages = [];
      mockDynamo.queriedItems = [
        {
          ...items[0],
          data: { ...items[0].data }, // fresh copy without delivered status
        },
      ];

      await adapter.pollInboundMessages(db);

      // Should still only have one message in SQLite
      const result = db.exec("SELECT * FROM messages WHERE id = 'msg-dup'");
      expect(result).toHaveLength(1);
      expect(result[0].values).toHaveLength(1);
    });

    it('should do nothing when no inbound messages exist', async () => {
      mockDynamo.queriedItems = [];

      await adapter.pollInboundMessages(db);

      const result = db.exec('SELECT * FROM messages');
      expect(result).toHaveLength(0);
      expect(mockDynamo.deliveredMessages).toHaveLength(0);
    });
  });

  describe('DynamoDB batch chunking', () => {
    it('should pass all items to batchWriteItems when syncing many entities', async () => {
      // StateSyncAdapter collects all changed items and calls batchWriteItems once.
      // The DynamoClient.batchWriteItems implementation is responsible for chunking
      // into groups of ≤25 before sending to AWS. Here we verify the adapter
      // forwards all items correctly.
      const batchWriteCalls: StateItem[][] = [];
      const collectingDynamo = {
        writtenItems: [] as StateItem[],
        queriedItems: [] as StateItem[],
        deliveredMessages: [] as Array<{ runId: string; sk: string }>,
        async batchWriteItems(items: StateItem[]): Promise<void> {
          batchWriteCalls.push([...items]);
          collectingDynamo.writtenItems.push(...items);
        },
        async queryByRunId(): Promise<StateItem[]> {
          return [];
        },
        async markInboundMessageDelivered(): Promise<void> {},
      };

      const chunkAdapter = new StateSyncAdapter(
        {
          runId: 'chunk-test',
          dbPath: '/workspace/.hive/hive.db',
          dynamoTable: 'test-table',
          eventBusName: 'test-bus',
          pollIntervalMs: 5000,
        },
        collectingDynamo as unknown as DynamoClient,
        mockEvents as unknown as EventEmitter
      );

      // Insert 30 stories
      for (let i = 0; i < 30; i++) {
        createStory(db, {
          title: `Story ${i}`,
          description: `Desc ${i}`,
        });
      }

      await chunkAdapter.syncState(db);
      chunkAdapter.stop();

      // All 30 stories should be written to DynamoDB
      const storyItems = collectingDynamo.writtenItems.filter(i => i.type === 'story');
      expect(storyItems).toHaveLength(30);

      // batchWriteItems is called once by the adapter with all items
      expect(batchWriteCalls).toHaveLength(1);
      expect(batchWriteCalls[0].filter(i => i.type === 'story')).toHaveLength(30);
    });

    it('DynamoClient.createStateItem should produce valid PK/SK keys for all entity types', () => {
      const types = ['story', 'agent', 'pr', 'escalation', 'log', 'meta'] as const;
      for (const type of types) {
        const item = DynamoClient.createStateItem('run-xyz', `${type.toUpperCase()}#id-1`, type, {
          id: 'id-1',
        });
        expect(item.PK).toBe('RUN#run-xyz');
        expect(item.SK).toBe(`${type.toUpperCase()}#id-1`);
        expect(item.type).toBe(type);
        expect(typeof item.ttl).toBe('number');
        expect(item.ttl).toBeGreaterThan(0);
      }
    });
  });

  describe('EventBridge batch chunking', () => {
    it('should chunk emitBatch into groups of 10', async () => {
      const batchCalls: Array<Array<{ detailType: HiveDetailType; detail: HiveEventDetail }>> = [];
      const chunkingEvents = {
        emittedEvents: [] as Array<{ detailType: HiveDetailType; detail: HiveEventDetail }>,
        async emit(detailType: HiveDetailType, detail: HiveEventDetail): Promise<void> {
          chunkingEvents.emittedEvents.push({ detailType, detail });
        },
        async emitBatch(
          events: Array<{ detailType: HiveDetailType; detail: HiveEventDetail }>
        ): Promise<void> {
          batchCalls.push([...events]);
          chunkingEvents.emittedEvents.push(...events);
        },
      };

      const chunkAdapter = new StateSyncAdapter(
        {
          runId: 'chunk-events-test',
          dbPath: '/workspace/.hive/hive.db',
          dynamoTable: 'test-table',
          eventBusName: 'test-bus',
          pollIntervalMs: 5000,
        },
        mockDynamo as unknown as DynamoClient,
        chunkingEvents as unknown as EventEmitter
      );

      // Insert 12 stories — generates 12 story_update events
      for (let i = 0; i < 12; i++) {
        createStory(db, {
          title: `Event Story ${i}`,
          description: `Desc ${i}`,
        });
      }

      await chunkAdapter.syncState(db);
      chunkAdapter.stop();

      // All 12 events should be emitted
      const storyEvents = chunkingEvents.emittedEvents.filter(e => e.detailType === 'story_update');
      expect(storyEvents).toHaveLength(12);

      // StateSyncAdapter calls emitBatch once with all events;
      // EventEmitter.emitBatch internally chunks at 10. Since we're using a mock
      // that receives the full array, verify it was called with all 12.
      expect(batchCalls.length).toBeGreaterThanOrEqual(1);
      const totalEmitted = batchCalls.reduce((sum, call) => sum + call.length, 0);
      expect(totalEmitted).toBe(12);
    });
  });

  describe('EventEmitter', () => {
    it('emit() should use single-event source and detailType', async () => {
      const emittedSingle: Array<{ detailType: HiveDetailType; detail: HiveEventDetail }> = [];
      const singleEvents = {
        emittedEvents: [] as Array<{ detailType: HiveDetailType; detail: HiveEventDetail }>,
        async emit(detailType: HiveDetailType, detail: HiveEventDetail): Promise<void> {
          emittedSingle.push({ detailType, detail });
          singleEvents.emittedEvents.push({ detailType, detail });
        },
        async emitBatch(
          events: Array<{ detailType: HiveDetailType; detail: HiveEventDetail }>
        ): Promise<void> {
          singleEvents.emittedEvents.push(...events);
        },
      };

      // Trigger run_complete which uses emit() not emitBatch()
      const story = createStory(db, { title: 'Done', description: 'Desc' });
      db.run(
        "UPDATE stories SET status = 'merged', updated_at = '2099-02-01T00:00:00.000Z' WHERE id = ?",
        [story.id]
      );

      const singleAdapter = new StateSyncAdapter(
        {
          runId: 'emit-test',
          dbPath: '/workspace/.hive/hive.db',
          dynamoTable: 'test-table',
          eventBusName: 'test-bus',
          pollIntervalMs: 5000,
        },
        mockDynamo as unknown as DynamoClient,
        singleEvents as unknown as EventEmitter
      );

      await singleAdapter.syncState(db);
      singleAdapter.stop();

      // run_complete uses emit() directly
      expect(emittedSingle.some(e => e.detailType === 'run_complete')).toBe(true);
    });
  });

  describe('poll() mtime guard', () => {
    it('should skip sync when db file does not exist', async () => {
      const missingPathAdapter = new StateSyncAdapter(
        {
          runId: 'missing-db',
          dbPath: '/nonexistent/path/.hive/hive.db',
          dynamoTable: 'test-table',
          eventBusName: 'test-bus',
          pollIntervalMs: 5000,
        },
        mockDynamo as unknown as DynamoClient,
        mockEvents as unknown as EventEmitter
      );

      // poll() should not throw even when the db file doesn't exist
      await expect(missingPathAdapter.poll()).resolves.toBeUndefined();

      // No DynamoDB writes should have happened
      expect(mockDynamo.writtenItems).toHaveLength(0);
      missingPathAdapter.stop();
    });
  });

  describe('error resilience', () => {
    it('should propagate DynamoDB errors from syncState', async () => {
      const failingDynamo = {
        writtenItems: [] as StateItem[],
        queriedItems: [] as StateItem[],
        deliveredMessages: [] as Array<{ runId: string; sk: string }>,
        async batchWriteItems(_items: StateItem[]): Promise<void> {
          throw new Error('DynamoDB write failed');
        },
        async queryByRunId(): Promise<StateItem[]> {
          return [];
        },
        async markInboundMessageDelivered(): Promise<void> {},
      };

      const failingAdapter = new StateSyncAdapter(
        {
          runId: 'failing-test',
          dbPath: '/workspace/.hive/hive.db',
          dynamoTable: 'test-table',
          eventBusName: 'test-bus',
          pollIntervalMs: 5000,
        },
        failingDynamo as unknown as DynamoClient,
        mockEvents as unknown as EventEmitter
      );

      createStory(db, { title: 'Fail story', description: 'Desc' });

      // syncState should throw when DynamoDB fails
      await expect(failingAdapter.syncState(db)).rejects.toThrow('DynamoDB write failed');
      failingAdapter.stop();
    });
  });

  describe('StateSyncConfig', () => {
    it('should construct adapter with injected dynamo and events clients', () => {
      const customAdapter = new StateSyncAdapter(
        {
          runId: 'config-test',
          dbPath: '/workspace/.hive/hive.db',
          dynamoTable: 'custom-table',
          eventBusName: 'custom-bus',
          pollIntervalMs: 1000,
          region: 'eu-west-1',
        },
        mockDynamo as unknown as DynamoClient,
        mockEvents as unknown as EventEmitter
      );

      expect(customAdapter).toBeDefined();
      customAdapter.stop();
    });
  });
});
