const WorkflowDefinitionModel = require('../models/workflow-definition.model');
const { RulesetSchema } = require('../domain/rules/schema');
const { withTransaction } = require('../config/database');

class WorkflowImmutableError extends Error {
  constructor(message = 'Published workflow versions are strictly immutable and cannot be updated or deleted.') {
    super(message);
    this.name = 'WorkflowImmutableError';
    this.statusCode = 409;
  }
}

class WorkflowConfigService {
  /**
   * Registers a new workflow definition version.
   */
  static async registerWorkflow(definition) {
    // Validate ruleset structure with Zod
    if (definition.ruleset) {
      RulesetSchema.parse(definition.ruleset);
    }

    const workflow = new WorkflowDefinitionModel(definition);
    return await workflow.save();
  }

  /**
   * Updates a workflow definition (only if NOT published).
   */
  static async updateWorkflow(workflowId, version, updates) {
    const existing = await WorkflowDefinitionModel.findOne({ workflowId, version });
    if (!existing) {
      throw new Error(`Workflow [${workflowId}@${version}] not found.`);
    }

    if (existing.isPublished) {
      throw new WorkflowImmutableError();
    }

    if (updates.ruleset) {
      RulesetSchema.parse(updates.ruleset);
    }

    Object.assign(existing, updates);
    return await existing.save();
  }

  /**
   * Atomically activates a workflow version, deprecating previous active version.
   */
  static async activateWorkflowVersion(workflowId, targetVersion) {
    return await withTransaction(async (session) => {
      const target = await WorkflowDefinitionModel.findOne({
        workflowId,
        version: targetVersion
      }).session(session);

      if (!target) {
        throw new Error(`Target workflow [${workflowId}@${targetVersion}] does not exist.`);
      }

      // 1. Deprecate existing ACTIVE versions
      await WorkflowDefinitionModel.updateMany(
        { workflowId, status: 'ACTIVE' },
        { $set: { status: 'DEPRECATED' } },
        { session }
      );

      // 2. Activate target version and ensure published
      target.status = 'ACTIVE';
      target.isPublished = true;
      await target.save({ session });

      return target;
    });
  }

  /**
   * Retrieves the currently ACTIVE workflow definition.
   */
  static async getActiveWorkflow(workflowId) {
    const active = await WorkflowDefinitionModel.findOne({ workflowId, status: 'ACTIVE' });
    if (!active) {
      throw new Error(`No active workflow version found for [${workflowId}].`);
    }
    return active;
  }

  /**
   * Retrieves a specific version of a workflow definition.
   */
  static async getWorkflowVersion(workflowId, version) {
    const wf = await WorkflowDefinitionModel.findOne({ workflowId, version });
    if (!wf) {
      throw new Error(`Workflow version [${workflowId}@${version}] not found.`);
    }
    return wf;
  }

  /**
   * Lists all versions of a workflow.
   */
  static async listWorkflowVersions(workflowId) {
    return await WorkflowDefinitionModel.find({ workflowId }).sort({ createdAt: -1 });
  }
}

module.exports = {
  WorkflowConfigService,
  WorkflowImmutableError
};

