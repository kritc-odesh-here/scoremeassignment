const crypto = require('crypto');
const ApplicationModel = require('../models/application.model');
const { StateMachine, APPLICATION_STATES, InvalidStateTransitionError } = require('../domain/state-machine/state-machine');
const { CheckpointManager, STAGE_STATUS } = require('../domain/checkpoint/checkpoint-manager');
const RulesEngine = require('../domain/rules/rules-engine');
const { AuditService } = require('./audit-service');
const { WorkflowConfigService } = require('./workflow-config-service');
const { BureauGateway } = require('../integration/bureau-gateway');
const { withTransaction } = require('../config/database');

class OptimisticLockError extends Error {
  constructor(message = 'Concurrent state modification detected. Please reload and retry.') {
    super(message);
    this.name = 'OptimisticLockError';
    this.statusCode = 409;
  }
}

class WorkflowEngine {
  constructor(options = {}) {
    this.bureauGateway = options.bureauGateway || new BureauGateway();
  }

  /**
   * Generates a unique human-readable tracking number
   */
  static generateTrackingNumber() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `APP-${timestamp}-${random}`;
  }

  /**
   * Ingests a new business request and initiates multi-stage workflow execution.
   */
  async createAndExecute({ workflowId, workflowVersion, payload, faultConfig = {} }) {
    // 1. Resolve workflow definition (specified version or currently ACTIVE)
    let workflow;
    if (workflowVersion) {
      workflow = await WorkflowConfigService.getWorkflowVersion(workflowId, workflowVersion);
    } else {
      workflow = await WorkflowConfigService.getActiveWorkflow(workflowId);
    }

    const trackingNumber = WorkflowEngine.generateTrackingNumber();
    const initialStages = CheckpointManager.initializeStages(workflow.stages, trackingNumber);

    // 2. Initialize application in RECEIVED state within atomic transaction
    let app = await withTransaction(async (session) => {
      const newApp = new ApplicationModel({
        trackingNumber,
        workflowId: workflow.workflowId,
        workflowVersion: workflow.version,
        currentState: APPLICATION_STATES.RECEIVED,
        stateVersion: 1,
        inputPayload: payload,
        contextData: { ...payload },
        stages: initialStages
      });

      await newApp.save({ session });

      await AuditService.recordAuditEvent({
        application: newApp,
        eventType: 'APPLICATION_RECEIVED',
        fromState: null,
        toState: APPLICATION_STATES.RECEIVED,
        details: { initialPayload: payload },
        session
      });

      await newApp.save({ session });
      return newApp;
    });

    // 3. Drive workflow execution through stages
    return await this.executeStages(app, workflow, faultConfig);
  }

  /**
   * Drives an application through remaining workflow stages.
   * Resumes cleanly from checkpoint if recovering from a past failure.
   */
  async executeStages(app, workflow, faultConfig = {}) {
    const stages = workflow.stages;

    for (const stageDef of stages) {
      const stageId = stageDef.id;
      const currentCheckpoint = app.stages.get(stageId);

      // Checkpoint check: if already completed, bypass!
      if (currentCheckpoint && currentCheckpoint.status === STAGE_STATUS.COMPLETED) {
        continue;
      }

      // Execute Stage by Type
      if (stageDef.type === 'ENRICHMENT') {
        const result = await this.executeEnrichmentStage(app, stageDef, faultConfig);
        app = result.app;
        if (!result.success) {
          return app; // Execution halted at FAILED state
        }
      } else if (stageDef.type === 'RULE_EVALUATION' || stageDef.type === 'DECISION') {
        const result = await this.executeRuleEvaluationStage(app, workflow);
        app = result.app;
        if (!result.success) {
          return app;
        }
      }
    }

    return app;
  }

  /**
   * Executes an external enrichment stage (e.g., Credit Bureau Lookup)
   */
  async executeEnrichmentStage(app, stageDef, faultConfig = {}) {
    const stageId = stageDef.id;
    const checkpoint = app.stages.get(stageId);

    // 1. Transition to ENRICHING atomically
    StateMachine.assertTransition(app.currentState, APPLICATION_STATES.ENRICHING, app.trackingNumber);

    app = await withTransaction(async (session) => {
      const fromState = app.currentState;
      app.currentState = APPLICATION_STATES.ENRICHING;
      app.stages.set(stageId, CheckpointManager.startStage(checkpoint));
      app.markModified('stages');

      await AuditService.recordAuditEvent({
        application: app,
        eventType: 'STAGE_STARTED',
        fromState,
        toState: APPLICATION_STATES.ENRICHING,
        stepId: stageId,
        session
      });

      app.stateVersion += 1;
      await app.save({ session });
      return app;
    });

    // 2. Call external dependency with fault injection & external idempotency
    try {
      const bureauResult = await this.bureauGateway.fetchCreditReport(
        app.inputPayload,
        checkpoint.idempotencyToken,
        faultConfig
      );

      // 3. Mark Stage COMPLETED and update contextData atomically
      app = await withTransaction(async (session) => {
        const completedCheckpoint = CheckpointManager.completeStage(
          app.stages.get(stageId),
          bureauResult.profile
        );
        app.stages.set(stageId, completedCheckpoint);
        app.markModified('stages');

        // Merge enriched data into context
        const context = {
          ...app.contextData,
          credit: bureauResult.profile,
          enrichment: {
            bureau: bureauResult.profile
          }
        };
        app.contextData = context;
        app.markModified('contextData');

        await AuditService.recordAuditEvent({
          application: app,
          eventType: 'STAGE_COMPLETED',
          fromState: APPLICATION_STATES.ENRICHING,
          toState: APPLICATION_STATES.ENRICHING,
          stepId: stageId,
          details: {
            isReplay: bureauResult.isReplay,
            totalAttempts: bureauResult.totalAttempts,
            profileSummary: {
              creditScore: bureauResult.profile.creditScore,
              debtToIncome: bureauResult.profile.debtToIncome
            }
          },
          session
        });

        app.stateVersion += 1;
        await app.save({ session });
        return app;
      });

      return { success: true, app };
    } catch (err) {
      // 4. External Failure! Transition to FAILED state and record checkpoint
      app = await withTransaction(async (session) => {
        const failedCheckpoint = CheckpointManager.failStage(
          app.stages.get(stageId),
          err,
          err.isTransient
        );
        app.stages.set(stageId, failedCheckpoint);
        app.markModified('stages');
        app.currentState = APPLICATION_STATES.FAILED;

        await AuditService.recordAuditEvent({
          application: app,
          eventType: 'STAGE_FAILED',
          fromState: APPLICATION_STATES.ENRICHING,
          toState: APPLICATION_STATES.FAILED,
          stepId: stageId,
          details: {
            errorCode: err.code || 'EXTERNAL_SERVICE_ERROR',
            errorMessage: err.message,
            statusCode: err.statusCode,
            isTransient: err.isTransient,
            attempts: err.attempts || 1
          },
          session
        });

        app.stateVersion += 1;
        await app.save({ session });
        return app;
      });

      return { success: false, app };
    }
  }

  /**
   * Executes the AST Rules Engine stage
   */
  async executeRuleEvaluationStage(app, workflow) {
    const stageId = 'rule_evaluation';

    // 1. Transition to EVALUATING
    StateMachine.assertTransition(app.currentState, APPLICATION_STATES.EVALUATING, app.trackingNumber);

    app = await withTransaction(async (session) => {
      app.currentState = APPLICATION_STATES.EVALUATING;

      await AuditService.recordAuditEvent({
        application: app,
        eventType: 'STATE_TRANSITION',
        fromState: APPLICATION_STATES.ENRICHING,
        toState: APPLICATION_STATES.EVALUATING,
        stepId: stageId,
        session
      });

      app.stateVersion += 1;
      await app.save({ session });
      return app;
    });

    // 2. Pure in-memory AST rules evaluation
    const evaluationResult = RulesEngine.evaluateRuleset(workflow.ruleset, app.contextData);
    const targetState = evaluationResult.outcome; // 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW'

    // Assert legal transition to final state
    StateMachine.assertTransition(app.currentState, targetState, app.trackingNumber);

    // 3. Atomically persist final decision, state, and audit trace
    app = await withTransaction(async (session) => {
      app.currentState = targetState;
      app.decision = {
        outcome: evaluationResult.outcome,
        reasonCode: evaluationResult.reasonCode,
        summary: evaluationResult.summary,
        matchingRuleId: evaluationResult.matchingRuleId,
        tags: evaluationResult.tags || [],
        finalizedAt: targetState === APPLICATION_STATES.MANUAL_REVIEW ? null : new Date()
      };

      // Mark stage completed
      const checkpoint = app.stages.get(stageId) || { stageId, idempotencyToken: 'rule_eval' };
      app.stages.set(stageId, CheckpointManager.completeStage(checkpoint, {
        outcome: evaluationResult.outcome,
        reasonCode: evaluationResult.reasonCode,
        matchingRuleId: evaluationResult.matchingRuleId
      }));
      app.markModified('stages');

      // Store evaluation trace in context for explainability API
      app.contextData = {
        ...app.contextData,
        _evaluationTrace: {
          decision: app.decision,
          rulesetVersion: workflow.version,
          ruleTraces: evaluationResult.ruleTraces,
          evaluatedAt: evaluationResult.evaluatedAt
        }
      };
      app.markModified('contextData');

      await AuditService.recordAuditEvent({
        application: app,
        eventType: 'DECISION_REACHED',
        fromState: APPLICATION_STATES.EVALUATING,
        toState: targetState,
        stepId: stageId,
        details: {
          decision: app.decision,
          ruleTracesSummary: evaluationResult.ruleTraces.map((t) => ({
            ruleId: t.ruleId,
            status: t.status,
            priority: t.priority
          }))
        },
        session
      });

      app.stateVersion += 1;
      await app.save({ session });
      return app;
    });

    return { success: true, app };
  }

  /**
   * Resumes execution from the failed stage checkpoint
   */
  async resumeExecution(trackingNumber, faultConfig = {}) {
    const app = await ApplicationModel.findOne({ trackingNumber });
    if (!app) {
      throw new Error(`Application [${trackingNumber}] not found.`);
    }

    if (app.currentState !== APPLICATION_STATES.FAILED) {
      throw new Error(`Cannot retry application in state '${app.currentState}'. Only 'FAILED' applications can be retried.`);
    }

    const workflow = await WorkflowConfigService.getWorkflowVersion(app.workflowId, app.workflowVersion);

    // Reset failed stage status to PENDING
    for (const [stageId, checkpoint] of app.stages.entries()) {
      if (checkpoint.status === STAGE_STATUS.FAILED) {
        checkpoint.status = STAGE_STATUS.PENDING;
        app.stages.set(stageId, checkpoint);
      }
    }
    app.markModified('stages');

    app.retryCount = (app.retryCount || 0) + 1;

    // Record retry trigger audit event while maintaining FAILED state for stage transition
    await withTransaction(async (session) => {
      await AuditService.recordAuditEvent({
        application: app,
        eventType: 'WORKFLOW_RETRY_TRIGGERED',
        fromState: APPLICATION_STATES.FAILED,
        toState: APPLICATION_STATES.FAILED,
        details: { retryAttempt: app.retryCount },
        session
      });

      app.stateVersion += 1;
      await app.save({ session });
    });

    return await this.executeStages(app, workflow, faultConfig);
  }

  /**
   * Submits a manual underwriter review decision
   */
  async submitManualReview(trackingNumber, { action, reviewerId, notes, expectedVersion }) {
    const app = await ApplicationModel.findOne({ trackingNumber });
    if (!app) {
      throw new Error(`Application [${trackingNumber}] not found.`);
    }

    if (app.currentState !== APPLICATION_STATES.MANUAL_REVIEW) {
      throw new Error(`Cannot submit manual review for application in state '${app.currentState}'. Must be 'MANUAL_REVIEW'.`);
    }

    // Optimistic Concurrency Control Check
    if (expectedVersion !== undefined && app.stateVersion !== expectedVersion) {
      throw new OptimisticLockError();
    }

    const targetState = action === 'APPROVE' ? APPLICATION_STATES.APPROVED : APPLICATION_STATES.REJECTED;
    StateMachine.assertTransition(app.currentState, targetState, trackingNumber);

    return await withTransaction(async (session) => {
      const fromState = app.currentState;
      app.currentState = targetState;
      app.decision = {
        outcome: targetState,
        reasonCode: action === 'APPROVE' ? 'MANUAL_UNDERWRITER_APPROVAL' : 'MANUAL_UNDERWRITER_REJECTION',
        summary: notes || `Manually resolved to ${targetState} by underwriter.`,
        finalizedAt: new Date()
      };
      app.reviewNotes = {
        reviewerId: reviewerId || 'ANONYMOUS_REVIEWER',
        notes: notes || '',
        reviewedAt: new Date()
      };

      await AuditService.recordAuditEvent({
        application: app,
        eventType: 'MANUAL_REVIEW_SUBMITTED',
        fromState,
        toState: targetState,
        details: {
          action,
          reviewerId,
          notes
        },
        actor: {
          type: 'USER',
          id: reviewerId || 'REVIEWER'
        },
        session
      });

      app.stateVersion += 1;
      await app.save({ session });
      return app;
    });
  }
}

module.exports = {
  WorkflowEngine,
  OptimisticLockError
};
