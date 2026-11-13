const mongoose = require('mongoose');

const WorkflowDefinitionSchema = new mongoose.Schema(
  {
    workflowId: { type: String, required: true, index: true },
    version: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'DEPRECATED'],
      default: 'DRAFT',
      index: true
    },
    isPublished: { type: Boolean, default: false },
    stages: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        type: {
          type: String,
          enum: ['VALIDATION', 'ENRICHMENT', 'RULE_EVALUATION', 'DECISION', 'MANUAL_REVIEW'],
          required: true
        },
        handler: { type: String, required: true },
        config: { type: mongoose.Schema.Types.Mixed, default: {} }
      }
    ],
    ruleset: { type: mongoose.Schema.Types.Mixed, required: true },
    defaultOutcome: {
      outcome: { type: String, enum: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW'], default: 'MANUAL_REVIEW' },
      reasonCode: { type: String, default: 'DEFAULT_REVIEW' },
      summary: { type: String, default: 'Default underwriting review required.' }
    }
  },
  {
    timestamps: true
  }
);

// Guarantee version uniqueness
WorkflowDefinitionSchema.index({ workflowId: 1, version: 1 }, { unique: true });

// Enforce strictly ONE ACTIVE version per workflow at the database level
WorkflowDefinitionSchema.index(
  { workflowId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'ACTIVE' }
  }
);

const WorkflowDefinitionModel = mongoose.model('WorkflowDefinition', WorkflowDefinitionSchema);

module.exports = WorkflowDefinitionModel;

