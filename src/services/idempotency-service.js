const crypto = require('crypto');
const IdempotencyKeyModel = require('../models/idempotency-key.model');
const { AuditService } = require('./audit-service');

class IdempotencyConflictError extends Error {
  constructor(message = 'A request with this Idempotency-Key is currently in progress. Please retry shortly.') {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.statusCode = 409;
  }
}

class IdempotencyPayloadMismatchError extends Error {
  constructor(message = 'Idempotency-Key payload mismatch: Key previously used with a different request payload.') {
    super(message);
    this.name = 'IdempotencyPayloadMismatchError';
    this.statusCode = 422;
  }
}

class IdempotencyService {
  /**
   * Computes SHA-256 hash of canonical method, path, and body.
   */
  static computeRequestHash(method, path, body) {
    const canonicalBody = AuditService.canonicalize(body || {});
    return crypto
      .createHash('sha256')
      .update(`${String(method).toUpperCase()}:${String(path)}:${canonicalBody}`)
      .digest('hex');
  }

  /**
   * Acquires an idempotency lease using atomic unique-key insertion and safe reclamation.
   */
  static async acquireLease({ key, method, path, body, leaseDurationMs = 60000 }) {
    if (!key) {
      throw new Error('Idempotency key is required.');
    }

    const requestHash = IdempotencyService.computeRequestHash(method, path, body);
    const workerToken = crypto.randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    try {
      // 1. Attempt atomic insertion (clean acquisition)
      await IdempotencyKeyModel.create({
        _id: key,
        requestHash,
        status: 'PROCESSING',
        ownerToken: workerToken,
        leaseExpiresAt,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) // 24h TTL
      });

      return {
        isNew: true,
        ownerToken: workerToken,
        key
      };
    } catch (err) {
      // Duplicate key E11000
      if (err.code !== 11000) {
        throw err;
      }

      // 2. Key exists, inspect record
      const existing = await IdempotencyKeyModel.findById(key);
      if (!existing) {
        // Race condition: record was deleted between create failure and find
        return IdempotencyService.acquireLease({ key, method, path, body, leaseDurationMs });
      }

      // Check COMPLETED status
      if (existing.status === 'COMPLETED') {
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyPayloadMismatchError();
        }

        return {
          isCached: true,
          statusCode: existing.statusCode || 200,
          responseBody: existing.responseBody,
          key
        };
      }

      // Check PROCESSING status
      if (existing.status === 'PROCESSING') {
        if (existing.leaseExpiresAt > now) {
          // Active worker currently running
          throw new IdempotencyConflictError();
        }

        // Lease expired! Stalled / crashed zombie worker detected.
        // Attempt safe atomic lease reclamation:
        const reclaimed = await IdempotencyKeyModel.findOneAndUpdate(
          {
            _id: key,
            status: 'PROCESSING',
            leaseExpiresAt: { $lte: now }
          },
          {
            $set: {
              ownerToken: workerToken,
              leaseExpiresAt,
              requestHash
            }
          },
          { new: true }
        );

        if (reclaimed) {
          return {
            isNew: true,
            isReclaimed: true,
            ownerToken: workerToken,
            key
          };
        }

        // Another concurrent worker claimed the expired lease
        throw new IdempotencyConflictError();
      }

      throw new IdempotencyConflictError();
    }
  }

  /**
   * Commits successful response to idempotency record with owner token guard.
   * Stale workers whose lease was reclaimed will fail to match ownerToken.
   */
  static async commitCompletion(key, ownerToken, statusCode, responseBody) {
    const updated = await IdempotencyKeyModel.findOneAndUpdate(
      {
        _id: key,
        ownerToken, // Strict owner guard prevents stale worker overwrite
        status: 'PROCESSING'
      },
      {
        $set: {
          status: 'COMPLETED',
          statusCode,
          responseBody
        }
      },
      { new: true }
    );

    return Boolean(updated);
  }

  /**
   * Releases lease on failure so client can retry immediately.
   */
  static async releaseLease(key, ownerToken) {
    await IdempotencyKeyModel.deleteOne({
      _id: key,
      ownerToken,
      status: 'PROCESSING'
    });
  }
}

module.exports = {
  IdempotencyService,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError
};

