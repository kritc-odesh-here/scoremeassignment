const mongoose = require('mongoose');
const { APPLICATION_STATES } = require('../domain/state-machine/states');

const StageCheckpointSchema = new mongoose.Schema(
  {
    stageId: { type: String, required: true },
    name: { type: String },
    type: { type: String },
    status: {
      type: String,
      enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'],
      default: 'PENDING'
    },
    attempts: { type: Number, default: 0 },
    idempotencyToken: { type: String, required: true },
    output: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: {
      code: String,
      message: String,
      isTransient: Boolean,
      timestamp: Date
    },
    startedAt: { type: Date },
    completedAt: { type: Date }
  },
  { _id: false }
);

const ApplicationSchema = new mongoose.Schema(
  {
    trackingNumber: { type: String, required: true, unique: true, index: true },
    workflowId: { type: String, required: true, index: true },
    workflowVersion: { type: String, required: true },
    currentState: {
      type: String,
      enum: Object.values(APPLICATION_STATES),
      default: APPLICATION_STATES.RECEIVED,
      index: true
    },
    stateVersion: { type: Number, default: 1, required: true }, // Optimistic Concurrency Control
    auditSequenceCounter: { type: Number, default: 0, required: true },
    lastAuditHash: {
      type: String,
      default: '0000000000000000000000000000000000000000000000000000000000000000',
      required: true
    },
    inputPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    contextData: { type: mongoose.Schema.Types.Mixed, default: {} },
    stages: {
      type: Map,
      of: StageCheckpointSchema,
      default: {}
    },
    decision: {
      outcome: { type: String, enum: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW'] },
      reasonCode: { type: String },
      summary: { type: String },
      matchingRuleId: { type: String },
      tags: [{ type: String }],
      finalizedAt: { type: Date }
    },
    reviewNotes: {
      reviewerId: String,
      notes: String,
      reviewedAt: Date
    },
    retryCount: { type: Number, default: 0 }
  },
  {
    timestamps: true
  }
);

const ApplicationModel = mongoose.model('Application', ApplicationSchema);

module.exports = ApplicationModel;

