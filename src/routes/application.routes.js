const express = require('express');
const router = express.Router();

const ApplicationModel = require('../models/application.model');
const AuditLogModel = require('../models/audit-log.model');
const { AuditService } = require('../services/audit-service');
const { WorkflowEngine } = require('../services/workflow-engine');
const { validateBody } = require('../middleware/technical-validator');
const { idempotencyFilter } = require('../middleware/idempotency-middleware');
const {
  ApplicationSubmissionSchema,
  ManualReviewSchema
} = require('./schemas/application-submission.schema');

const engine = new WorkflowEngine();

/**
 * POST /api/v1/applications
 * Ingests a new application and executes workflow to completion.
 * Enforces technical validation (400) and idempotency (409/422/200).
 */
router.post(
  '/',
  validateBody(ApplicationSubmissionSchema),
  idempotencyFilter({ required: true }),
  async (req, res, next) => {
    try {
      const { workflowId, workflowVersion, applicant } = req.body;
      const faultConfig = req.headers['x-simulate-fault']
        ? JSON.parse(req.headers['x-simulate-fault'])
        : {};

      const app = await engine.createAndExecute({
        workflowId,
        workflowVersion,
        payload: {
          ...applicant,
          applicant
        },
        faultConfig
      });

      res.status(201).json({
        trackingNumber: app.trackingNumber,
        workflowId: app.workflowId,
        workflowVersion: app.workflowVersion,
        currentState: app.currentState,
        stateVersion: app.stateVersion,
        decision: app.decision,
        stages: Object.fromEntries(app.stages),
        createdAt: app.createdAt
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/applications/:trackingNumber
 * Fetches current application state and decision.
 */
router.get('/:trackingNumber', async (req, res, next) => {
  try {
    const app = await ApplicationModel.findOne({ trackingNumber: req.params.trackingNumber });
    if (!app) {
      return res.status(404).json({ error: 'NotFound', message: 'Application not found.' });
    }

    res.json({
      trackingNumber: app.trackingNumber,
      workflowId: app.workflowId,
      workflowVersion: app.workflowVersion,
      currentState: app.currentState,
      stateVersion: app.stateVersion,
      decision: app.decision,
      contextData: app.contextData,
      stages: Object.fromEntries(app.stages),
      reviewNotes: app.reviewNotes,
      retryCount: app.retryCount,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/applications/:trackingNumber/explain
 * Explainable decision report showing all evaluated rules, thresholds, and condition trees.
 */
router.get('/:trackingNumber/explain', async (req, res, next) => {
  try {
    const app = await ApplicationModel.findOne({ trackingNumber: req.params.trackingNumber });
    if (!app) {
      return res.status(404).json({ error: 'NotFound', message: 'Application not found.' });
    }

    const traceData = app.contextData?._evaluationTrace;

    res.json({
      trackingNumber: app.trackingNumber,
      workflowId: app.workflowId,
      workflowVersion: app.workflowVersion,
      currentState: app.currentState,
      decision: app.decision,
      evaluationSummary: {
        matchingRuleId: app.decision?.matchingRuleId || null,
        reasonCode: app.decision?.reasonCode,
        evaluatedAt: traceData?.evaluatedAt || app.updatedAt
      },
      ruleTraces: traceData?.ruleTraces || []
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/applications/:trackingNumber/audit
 * Retrieves immutable chronological audit log.
 */
router.get('/:trackingNumber/audit', async (req, res, next) => {
  try {
    const app = await ApplicationModel.findOne({ trackingNumber: req.params.trackingNumber });
    if (!app) {
      return res.status(404).json({ error: 'NotFound', message: 'Application not found.' });
    }

    const logs = await AuditLogModel.find({ applicationId: app._id }).sort({ sequenceNumber: 1 });

    res.json({
      trackingNumber: app.trackingNumber,
      totalEvents: logs.length,
      latestHash: app.lastAuditHash,
      auditRecords: logs.map((log) => ({
        sequenceNumber: log.sequenceNumber,
        eventType: log.eventType,
        fromState: log.fromState,
        toState: log.toState,
        stepId: log.stepId,
        previousHash: log.previousHash,
        eventHash: log.eventHash,
        details: log.details,
        actor: log.actor,
        timestamp: log.timestamp
      }))
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/applications/:trackingNumber/audit/verify
 * Cryptographic audit chain verification endpoint.
 */
router.get('/:trackingNumber/audit/verify', async (req, res, next) => {
  try {
    const app = await ApplicationModel.findOne({ trackingNumber: req.params.trackingNumber });
    if (!app) {
      return res.status(404).json({ error: 'NotFound', message: 'Application not found.' });
    }

    const verification = await AuditService.verifyAuditChain(app._id);

    if (!verification.valid) {
      return res.status(409).json({
        valid: false,
        trackingNumber: app.trackingNumber,
        brokenAtSequence: verification.brokenAtSequence,
        error: verification.error
      });
    }

    res.json({
      valid: true,
      trackingNumber: app.trackingNumber,
      totalEvents: verification.totalEvents,
      genesisHash: verification.genesisHash,
      latestHash: verification.latestHash,
      verifiedAt: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/applications/:trackingNumber/review
 * Submits an underwriter manual review decision.
 */
router.post(
  '/:trackingNumber/review',
  validateBody(ManualReviewSchema),
  async (req, res, next) => {
    try {
      const { action, reviewerId, notes, expectedVersion } = req.body;
      const app = await engine.submitManualReview(req.params.trackingNumber, {
        action,
        reviewerId,
        notes,
        expectedVersion
      });

      res.json({
        trackingNumber: app.trackingNumber,
        currentState: app.currentState,
        stateVersion: app.stateVersion,
        decision: app.decision,
        reviewNotes: app.reviewNotes,
        updatedAt: app.updatedAt
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/applications/:trackingNumber/retry
 * Resumes execution from failed stage checkpoint.
 */
router.post('/:trackingNumber/retry', async (req, res, next) => {
  try {
    const faultConfig = req.body?.faultConfig || {};
    const app = await engine.resumeExecution(req.params.trackingNumber, faultConfig);

    res.json({
      trackingNumber: app.trackingNumber,
      currentState: app.currentState,
      stateVersion: app.stateVersion,
      decision: app.decision,
      retryCount: app.retryCount,
      stages: Object.fromEntries(app.stages)
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

