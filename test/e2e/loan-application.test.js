const request = require('supertest');
const { setupTestDB, teardownTestDB, clearTestDB } = require('../test-db');
const { createApp } = require('../../src/app');
const { seedLoanWorkflow } = require('../../src/seeds/loan-workflow.seed');
const ApplicationModel = require('../../src/models/application.model');

describe('End-to-End Loan Application Workflow Tests', () => {
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

  describe('1. Technical Schema Validation vs Business Eligibility', () => {
    test('Invalid request schema returns HTTP 400 and creates NO database records', async () => {
      const invalidPayload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'Bob',
          // Missing lastName
          nationalId: 'SSN-999',
          email: 'not-an-email', // invalid email
          annualIncome: -5000, // negative income
          requestedAmount: 10000,
          loanPurpose: 'AUTO'
        }
      };

      const res = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-val-err-01')
        .send(invalidPayload);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('TechnicalValidationError');
      expect(res.body.issues).toBeDefined();
      expect(res.body.issues.length).toBeGreaterThan(0);

      // Verify ZERO records created in database
      const count = await ApplicationModel.countDocuments();
      expect(count).toBe(0);
    });
  });

  describe('2. Business Eligibility Outcomes', () => {
    test('Prime Applicant is automatically APPROVED with prime reason code and full trace', async () => {
      const primePayload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'John',
          lastName: 'Prime',
          nationalId: 'SSN-PRIME-123',
          email: 'john.prime@example.com',
          annualIncome: 120000,
          requestedAmount: 25000,
          loanPurpose: 'DEBT_CONSOLIDATION'
        }
      };

      const res = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-prime-001')
        .send(primePayload);

      expect(res.status).toBe(201);
      expect(res.body.currentState).toBe('APPROVED');
      expect(res.body.decision.outcome).toBe('APPROVED');
      expect(res.body.decision.reasonCode).toBe('PRIME_UNDERWRITING_PASS');
      expect(res.body.decision.matchingRuleId).toBe('RULE_PRIME_AUTO_APPROVAL');

      // Fetch explainable decision report
      const explainRes = await request(app)
        .get(`/api/v1/applications/${res.body.trackingNumber}/explain`);

      expect(explainRes.status).toBe(200);
      expect(explainRes.body.decision.outcome).toBe('APPROVED');
      expect(explainRes.body.ruleTraces).toBeDefined();

      const matchedTrace = explainRes.body.ruleTraces.find((t) => t.status === 'MATCHED');
      expect(matchedTrace).toBeDefined();
      expect(matchedTrace.ruleId).toBe('RULE_PRIME_AUTO_APPROVAL');

      // Check subsequent rules were short-circuited
      const notEvalTrace = explainRes.body.ruleTraces.find((t) => t.status === 'NOT_EVALUATED');
      expect(notEvalTrace).toBeDefined();
      expect(notEvalTrace.reason).toContain('Short-circuited by higher-priority match');
    });

    test('High Risk / Subprime Applicant is automatically REJECTED', async () => {
      const subprimePayload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'Frank',
          lastName: 'Subprime',
          nationalId: 'SSN-SUBPRIME-000', // Triggers subprime mock profile
          email: 'frank.subprime@example.com',
          annualIncome: 30000,
          requestedAmount: 20000,
          loanPurpose: 'PERSONAL'
        }
      };

      const res = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-subprime-001')
        .send(subprimePayload);

      expect(res.status).toBe(201);
      expect(res.body.currentState).toBe('REJECTED');
      expect(res.body.decision.outcome).toBe('REJECTED');
      expect(res.body.decision.reasonCode).toBe('HIGH_CREDIT_RISK_POLICY');
      expect(res.body.decision.matchingRuleId).toBe('RULE_HIGH_RISK_REJECTION');
    });

    test('Near Prime Applicant routes to MANUAL_REVIEW, then APPROVED by underwriter', async () => {
      const reviewPayload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'Sarah',
          lastName: 'Review',
          nationalId: 'SSN-REVIEW-555', // Triggers borderline credit score (640)
          email: 'sarah.review@example.com',
          annualIncome: 65000,
          requestedAmount: 15000,
          loanPurpose: 'HOME_REPAIR'
        }
      };

      // 1. Initial intake routes to MANUAL_REVIEW
      const res = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-review-001')
        .send(reviewPayload);

      expect(res.status).toBe(201);
      expect(res.body.currentState).toBe('MANUAL_REVIEW');
      expect(res.body.decision.outcome).toBe('MANUAL_REVIEW');
      expect(res.body.decision.reasonCode).toBe('NEAR_PRIME_REVIEW_REQUIRED');

      const trackingNumber = res.body.trackingNumber;

      // 2. Underwriter submits manual approval
      const reviewRes = await request(app)
        .post(`/api/v1/applications/${trackingNumber}/review`)
        .send({
          action: 'APPROVE',
          reviewerId: 'UW-OFFICER-77',
          notes: 'Verified stable employment and secondary collateral.'
        });

      expect(reviewRes.status).toBe(200);
      expect(reviewRes.body.currentState).toBe('APPROVED');
      expect(reviewRes.body.decision.outcome).toBe('APPROVED');
      expect(reviewRes.body.reviewNotes.reviewerId).toBe('UW-OFFICER-77');
    });

    test('Mandatory Sanctions check blocks applicant immediately', async () => {
      const sanctionedPayload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'Victor',
          lastName: 'Blocked',
          nationalId: 'SSN-SANCTIONED-999',
          email: 'victor.blocked@example.com',
          annualIncome: 200000,
          requestedAmount: 50000,
          loanPurpose: 'BUSINESS',
          isSanctioned: true // Trigger mandatory compliance rule
        }
      };

      const res = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-sanction-001')
        .send(sanctionedPayload);

      expect(res.status).toBe(201);
      expect(res.body.currentState).toBe('REJECTED');
      expect(res.body.decision.reasonCode).toBe('SANCTIONS_COMPLIANCE_BLOCK');
    });
  });

  describe('3. Fault Simulation, Stage Checkpoints & Retry Recovery', () => {
    test('Simulated transient dependency failure halts at FAILED; /retry resumes successfully', async () => {
      const payload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'Diana',
          lastName: 'Retry',
          nationalId: 'SSN-PRIME-RETRY',
          email: 'diana.retry@example.com',
          annualIncome: 90000,
          requestedAmount: 15000,
          loanPurpose: 'VEHICLE'
        }
      };

      // 1. Trigger failure: configure Bureau to ALWAYS_FAIL
      const failRes = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-fault-001')
        .set('x-simulate-fault', JSON.stringify({ failureMode: 'ALWAYS_FAIL' }))
        .send(payload);

      expect(failRes.status).toBe(201);
      expect(failRes.body.currentState).toBe('FAILED');
      expect(failRes.body.stages.bureau_enrichment.status).toBe('FAILED');

      const trackingNumber = failRes.body.trackingNumber;

      // 2. Retry execution with fault cleared
      const retryRes = await request(app)
        .post(`/api/v1/applications/${trackingNumber}/retry`)
        .send({ faultConfig: { failureMode: 'NONE' } });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.currentState).toBe('APPROVED');
      expect(retryRes.body.retryCount).toBe(1);
      expect(retryRes.body.stages.bureau_enrichment.status).toBe('COMPLETED');
      expect(retryRes.body.decision.outcome).toBe('APPROVED');
    });
  });

  describe('4. Cryptographic Audit Trail Verification', () => {
    test('Audit log verifies 100% valid SHA-256 hash-chain from genesis to terminal state', async () => {
      const payload = {
        workflowId: 'loan_approval',
        applicant: {
          firstName: 'Elena',
          lastName: 'Audit',
          nationalId: 'SSN-PRIME-AUDIT',
          email: 'elena.audit@example.com',
          annualIncome: 110000,
          requestedAmount: 20000,
          loanPurpose: 'CONSOLIDATION'
        }
      };

      const res = await request(app)
        .post('/api/v1/applications')
        .set('Idempotency-Key', 'key-audit-verify-001')
        .send(payload);

      const trackingNumber = res.body.trackingNumber;

      // Fetch audit log
      const auditRes = await request(app)
        .get(`/api/v1/applications/${trackingNumber}/audit`);

      expect(auditRes.status).toBe(200);
      expect(auditRes.body.totalEvents).toBeGreaterThanOrEqual(4);
      expect(auditRes.body.auditRecords[0].sequenceNumber).toBe(1);
      expect(auditRes.body.auditRecords[0].previousHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');

      // Verify chain integrity
      const verifyRes = await request(app)
        .get(`/api/v1/applications/${trackingNumber}/audit/verify`);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.valid).toBe(true);
      expect(verifyRes.body.totalEvents).toBe(auditRes.body.totalEvents);
      expect(verifyRes.body.latestHash).toBe(auditRes.body.latestHash);
    });
  });
});

