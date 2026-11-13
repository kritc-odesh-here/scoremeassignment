const { setupTestDB, teardownTestDB, clearTestDB } = require('../test-db');
const { AuditService, GENESIS_HASH } = require('../../src/services/audit-service');
const ApplicationModel = require('../../src/models/application.model');
const AuditLogModel = require('../../src/models/audit-log.model');

describe('Audit Trail & Cryptographic Hash Chain', () => {
  beforeAll(async () => {
    await setupTestDB();
  }, 60000);

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  test('Canonicalization produces deterministic JSON regardless of key ordering', () => {
    const objA = { b: 2, a: 1, c: { y: 20, x: 10 } };
    const objB = { a: 1, c: { x: 10, y: 20 }, b: 2 };

    const canonA = AuditService.canonicalize(objA);
    const canonB = AuditService.canonicalize(objB);

    expect(canonA).toBe(canonB);
    expect(canonA).toBe('{"a":1,"b":2,"c":{"x":10,"y":20}}');
  });

  test('Appends sequential audit events with correct previousHash chaining', async () => {
    const app = await ApplicationModel.create({
      trackingNumber: 'APP-TEST-001',
      workflowId: 'test_wf',
      workflowVersion: '1.0.0',
      currentState: 'RECEIVED',
      inputPayload: { amount: 5000 }
    });

    // Event 1
    const event1 = await AuditService.recordAuditEvent({
      application: app,
      eventType: 'APPLICATION_RECEIVED',
      fromState: null,
      toState: 'RECEIVED'
    });
    await app.save();

    expect(event1.sequenceNumber).toBe(1);
    expect(event1.previousHash).toBe(GENESIS_HASH);
    expect(event1.eventHash).toHaveLength(64);

    // Event 2
    const event2 = await AuditService.recordAuditEvent({
      application: app,
      eventType: 'STATE_TRANSITION',
      fromState: 'RECEIVED',
      toState: 'ENRICHING',
      stepId: 'bureau_check'
    });
    await app.save();

    expect(event2.sequenceNumber).toBe(2);
    expect(event2.previousHash).toBe(event1.eventHash);

    // Event 3
    const event3 = await AuditService.recordAuditEvent({
      application: app,
      eventType: 'DECISION_REACHED',
      fromState: 'ENRICHING',
      toState: 'APPROVED',
      details: { outcome: 'APPROVED' }
    });
    await app.save();

    expect(event3.sequenceNumber).toBe(3);
    expect(event3.previousHash).toBe(event2.eventHash);

    // Verify entire chain
    const verification = await AuditService.verifyAuditChain(app._id);
    expect(verification.valid).toBe(true);
    expect(verification.totalEvents).toBe(3);
    expect(verification.latestHash).toBe(event3.eventHash);
  });

  test('Detects tampering if canonicalData in a past event is modified', async () => {
    const app = await ApplicationModel.create({
      trackingNumber: 'APP-TEST-002',
      workflowId: 'test_wf',
      workflowVersion: '1.0.0',
      currentState: 'RECEIVED',
      inputPayload: { amount: 10000 }
    });

    await AuditService.recordAuditEvent({
      application: app,
      eventType: 'APPLICATION_RECEIVED',
      toState: 'RECEIVED'
    });
    await app.save();

    const event2 = await AuditService.recordAuditEvent({
      application: app,
      eventType: 'DECISION_REACHED',
      fromState: 'RECEIVED',
      toState: 'APPROVED',
      details: { outcome: 'APPROVED' }
    });
    await app.save();

    // Maliciously tamper with event 2 in the database
    await AuditLogModel.updateOne(
      { _id: event2._id },
      { $set: { canonicalData: '{"tampered":true}' } }
    );

    const verification = await AuditService.verifyAuditChain(app._id);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtSequence).toBe(2);
    expect(verification.error).toContain('Tampering detected at sequence 2');
  });

  test('Detects broken chain if an intermediate event is deleted', async () => {
    const app = await ApplicationModel.create({
      trackingNumber: 'APP-TEST-003',
      workflowId: 'test_wf',
      workflowVersion: '1.0.0',
      currentState: 'RECEIVED',
      inputPayload: { amount: 20000 }
    });

    await AuditService.recordAuditEvent({
      application: app,
      eventType: 'APPLICATION_RECEIVED',
      toState: 'RECEIVED'
    });
    await app.save();

    const event2 = await AuditService.recordAuditEvent({
      application: app,
      eventType: 'STATE_TRANSITION',
      fromState: 'RECEIVED',
      toState: 'ENRICHING'
    });
    await app.save();

    await AuditService.recordAuditEvent({
      application: app,
      eventType: 'DECISION_REACHED',
      fromState: 'ENRICHING',
      toState: 'APPROVED'
    });
    await app.save();

    // Delete intermediate event 2
    await AuditLogModel.deleteOne({ _id: event2._id });

    const verification = await AuditService.verifyAuditChain(app._id);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtSequence).toBe(3);
  });
});

