const request = require('supertest');
const { setupTestDB, teardownTestDB, clearTestDB } = require('../test-db');
const { createApp } = require('../../src/app');
const { seedLoanWorkflow } = require('../../src/seeds/loan-workflow.seed');

describe('Idempotency & Concurrency Integration Tests', () => {
  let app;

  beforeAll(async () => {
    await setupTestDB();
    await seedLoanWorkflow();
    app = createApp();
  }, 60000);

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    await seedLoanWorkflow();
  });

  const validPayload = {
    workflowId: 'loan_approval',
    applicant: {
      firstName: 'Alice',
      lastName: 'Smith',
      nationalId: 'SSN-123-45-6789',
      email: 'alice.smith@example.com',
      annualIncome: 95000,
      requestedAmount: 20000,
      loanPurpose: 'HOME_IMPROVEMENT'
    }
  };

  test('Requires Idempotency-Key header on POST /applications', async () => {
    const res = await request(app)
      .post('/api/v1/applications')
      .send(validPayload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MissingIdempotencyKey');
  });

  test('Processes new request with 201 Created and X-Cache-Lookup: MISS', async () => {
    const key = 'idem-test-key-001';

    const res = await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', key)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.headers['x-cache-lookup']).toBe('MISS');
    expect(res.body.trackingNumber).toBeDefined();
    expect(res.body.currentState).toBe('APPROVED');
  });

  test('Replays identical completed request with 200 OK and X-Cache-Lookup: HIT', async () => {
    const key = 'idem-test-key-002';

    // 1. Initial request
    const firstRes = await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', key)
      .send(validPayload);

    expect(firstRes.status).toBe(201);
    expect(firstRes.headers['x-cache-lookup']).toBe('MISS');
    const originalTracking = firstRes.body.trackingNumber;

    // 2. Duplicate request with same key and same body
    const secondRes = await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', key)
      .send(validPayload);

    expect(secondRes.status).toBe(201); // replays original statusCode
    expect(secondRes.headers['x-cache-lookup']).toBe('HIT');
    expect(secondRes.body.trackingNumber).toBe(originalTracking);
  });

  test('Rejects request with 422 Unprocessable Entity if Idempotency-Key is reused with different payload', async () => {
    const key = 'idem-test-key-003';

    // 1. Initial request
    await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', key)
      .send(validPayload);

    // 2. Different payload with same key
    const modifiedPayload = {
      ...validPayload,
      applicant: {
        ...validPayload.applicant,
        requestedAmount: 999999 // Different amount!
      }
    };

    const mismatchRes = await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', key)
      .send(modifiedPayload);

    expect(mismatchRes.status).toBe(422);
    expect(mismatchRes.body.error).toBe('IdempotencyPayloadMismatch');
  });
});

