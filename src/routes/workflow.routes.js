const express = require('express');
const router = express.Router();

const { WorkflowConfigService } = require('../services/workflow-config-service');
const RulesEngine = require('../domain/rules/rules-engine');

/**
 * POST /api/v1/workflows
 * Registers a new workflow definition.
 */
router.post('/', async (req, res, next) => {
  try {
    const workflow = await WorkflowConfigService.registerWorkflow(req.body);
    res.status(201).json(workflow);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/workflows/:workflowId
 * Lists all versions of a workflow.
 */
router.get('/:workflowId', async (req, res, next) => {
  try {
    const versions = await WorkflowConfigService.listWorkflowVersions(req.params.workflowId);
    res.json({
      workflowId: req.params.workflowId,
      totalVersions: versions.length,
      versions
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/workflows/:workflowId/activate
 * Atomically activates a specific version.
 */
router.post('/:workflowId/activate', async (req, res, next) => {
  try {
    const { version } = req.body;
    if (!version) {
      return res.status(400).json({ error: 'MissingVersion', message: "'version' is required in request body." });
    }

    const activated = await WorkflowConfigService.activateWorkflowVersion(req.params.workflowId, version);
    res.json({
      message: `Workflow [${req.params.workflowId}@${version}] is now ACTIVE.`,
      workflow: activated
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/workflows/:workflowId/test-rules
 * Ad-hoc rule evaluator endpoint (pure in-memory, zero database side-effects).
 */
router.post('/:workflowId/test-rules', async (req, res, next) => {
  try {
    const { version, contextData } = req.body;
    let workflow;
    if (version) {
      workflow = await WorkflowConfigService.getWorkflowVersion(req.params.workflowId, version);
    } else {
      workflow = await WorkflowConfigService.getActiveWorkflow(req.params.workflowId);
    }

    const evaluation = RulesEngine.evaluateRuleset(workflow.ruleset, contextData || {});
    res.json(evaluation);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

