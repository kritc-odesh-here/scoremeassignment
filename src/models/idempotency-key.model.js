const mongoose = require('mongoose');

const IdempotencyKeySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // Client-provided Idempotency-Key
    requestHash: { type: String, required: true }, // SHA-256 of method + path + canonicalBody
    status: {
      type: String,
      enum: ['PROCESSING', 'COMPLETED'],
      required: true,
      default: 'PROCESSING'
    },
    ownerToken: { type: String, required: true }, // Worker identifier claiming lease
    leaseExpiresAt: { type: Date, required: true }, // Active lock lease expiration
    statusCode: { type: Number },
    responseBody: { type: mongoose.Schema.Types.Mixed },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24-hour TTL
    }
  },
  {
    timestamps: true
  }
);

// TTL index to automatically purge old idempotency keys after expiration
IdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyKeyModel = mongoose.model('IdempotencyKey', IdempotencyKeySchema);

module.exports = IdempotencyKeyModel;

