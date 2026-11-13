const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
      index: true
    },
    trackingNumber: { type: String, required: true, index: true },
    workflowId: { type: String, required: true },
    workflowVersion: { type: String, required: true },
    sequenceNumber: { type: Number, required: true },
    previousHash: { type: String, required: true },
    eventHash: { type: String, required: true, index: true },
    eventType: {
      type: String,
      required: true,
      enum: [
        'APPLICATION_RECEIVED',
        'STAGE_STARTED',
        'STAGE_COMPLETED',
        'STAGE_FAILED',
        'STATE_TRANSITION',
        'RULES_EVALUATED',
        'DECISION_REACHED',
        'MANUAL_REVIEW_SUBMITTED',
        'WORKFLOW_RETRY_TRIGGERED'
      ]
    },
    fromState: { type: String },
    toState: { type: String },
    stepId: { type: String },
    canonicalData: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed },
    actor: {
      type: { type: String, enum: ['SYSTEM', 'WORKFLOW_ENGINE', 'USER', 'ADMIN'], default: 'SYSTEM' },
      id: { type: String, default: 'SYSTEM' }
    },
    timestamp: { type: Date, default: Date.now, index: true }
  },
  {
    timestamps: false
  }
);

// Guarantee monotonic sequential integrity per application
AuditLogSchema.index({ applicationId: 1, sequenceNumber: 1 }, { unique: true });

const AuditLogModel = mongoose.model('AuditLog', AuditLogSchema);

module.exports = AuditLogModel;

