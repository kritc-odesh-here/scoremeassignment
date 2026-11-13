const crypto = require('crypto');

const STAGE_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED'
};

class CheckpointManager {
  /**
   * Generates a deterministic external idempotency token for a stage call.
   */
  static generateStageIdempotencyToken(applicationId, stageId) {
    return crypto
      .createHash('sha256')
      .update(`${applicationId}:${stageId}`)
      .digest('hex');
  }

  /**
   * Initializes stage checkpoints for a workflow.
   */
  static initializeStages(workflowStages, applicationId) {
    const checkpoints = {};
    for (const stage of workflowStages) {
      checkpoints[stage.id] = {
        stageId: stage.id,
        name: stage.name,
        type: stage.type,
        status: STAGE_STATUS.PENDING,
        attempts: 0,
        idempotencyToken: this.generateStageIdempotencyToken(applicationId, stage.id),
        output: null,
        lastError: null,
        startedAt: null,
        completedAt: null
      };
    }
    return checkpoints;
  }

  /**
   * Finds the next stage to execute in order.
   * Returns null if all stages are completed.
   */
  static getNextStage(stagesConfig, currentCheckpoints) {
    for (const stage of stagesConfig) {
      const checkpoint = currentCheckpoints[stage.id];
      if (!checkpoint || checkpoint.status !== STAGE_STATUS.COMPLETED) {
        return stage;
      }
    }
    return null;
  }

  static toRawObject(checkpoint) {
    if (!checkpoint) return {};
    return typeof checkpoint.toObject === 'function' ? checkpoint.toObject() : checkpoint;
  }

  /**
   * Marks a stage as RUNNING.
   */
  static startStage(checkpoint) {
    const raw = this.toRawObject(checkpoint);
    return {
      ...raw,
      status: STAGE_STATUS.RUNNING,
      attempts: (raw.attempts || 0) + 1,
      startedAt: new Date(),
      lastError: null
    };
  }

  /**
   * Marks a stage as COMPLETED with output payload.
   */
  static completeStage(checkpoint, output) {
    const raw = this.toRawObject(checkpoint);
    return {
      ...raw,
      status: STAGE_STATUS.COMPLETED,
      output: output || {},
      completedAt: new Date()
    };
  }

  /**
   * Marks a stage as FAILED with error details.
   */
  static failStage(checkpoint, error, isTransient = false) {
    const raw = this.toRawObject(checkpoint);
    return {
      ...raw,
      status: STAGE_STATUS.FAILED,
      lastError: {
        code: error.code || 'STAGE_ERROR',
        message: error.message || String(error),
        isTransient,
        timestamp: new Date()
      }
    };
  }
}

module.exports = {
  STAGE_STATUS,
  CheckpointManager
};

