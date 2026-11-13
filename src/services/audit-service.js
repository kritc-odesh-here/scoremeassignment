const crypto = require('crypto');
const AuditLogModel = require('../models/audit-log.model');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

class AuditService {
  /**
   * RFC 8785 JSON Canonicalization (deterministic key sorting)
   */
  static canonicalize(obj) {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      return '[' + obj.map((item) => AuditService.canonicalize(item)).join(',') + ']';
    }

    const sortedKeys = Object.keys(obj).sort();
    const parts = sortedKeys.map((key) => {
      const val = obj[key];
      return JSON.stringify(key) + ':' + AuditService.canonicalize(val);
    });

    return '{' + parts.join(',') + '}';
  }

  /**
   * Computes SHA-256 hash of previousHash + canonicalEventData
   */
  static computeEventHash(previousHash, canonicalData) {
    return crypto
      .createHash('sha256')
      .update(String(previousHash) + String(canonicalData))
      .digest('hex');
  }

  /**
   * Appends an audit event to the tamper-evident cryptographic hash-chain.
   * Atomically advances the application's audit sequence and hash cursor.
   */
  static async recordAuditEvent({
    application,
    eventType,
    fromState,
    toState,
    stepId,
    details = {},
    actor = { type: 'SYSTEM', id: 'SYSTEM' },
    session = null
  }) {
    const sequenceNumber = (application.auditSequenceCounter || 0) + 1;
    const previousHash = application.lastAuditHash || GENESIS_HASH;

    // Structured data to be canonicalized
    const eventDataToHash = {
      applicationId: String(application._id),
      trackingNumber: application.trackingNumber,
      sequenceNumber,
      eventType,
      fromState: fromState || null,
      toState: toState || null,
      stepId: stepId || null,
      details,
      actor
    };

    const canonicalData = AuditService.canonicalize(eventDataToHash);
    const eventHash = AuditService.computeEventHash(previousHash, canonicalData);

    const auditRecord = new AuditLogModel({
      applicationId: application._id,
      trackingNumber: application.trackingNumber,
      workflowId: application.workflowId,
      workflowVersion: application.workflowVersion,
      sequenceNumber,
      previousHash,
      eventHash,
      eventType,
      fromState,
      toState,
      stepId,
      canonicalData,
      details,
      actor,
      timestamp: new Date()
    });

    await auditRecord.save({ session });

    // Update the application's cursors in memory (caller commits with application save)
    application.auditSequenceCounter = sequenceNumber;
    application.lastAuditHash = eventHash;

    return auditRecord;
  }

  /**
   * Verifies the entire cryptographic hash-chain for an application from sequence 1 to N.
   */
  static async verifyAuditChain(applicationId) {
    const records = await AuditLogModel.find({ applicationId }).sort({ sequenceNumber: 1 });

    if (!records || records.length === 0) {
      return { valid: true, totalEvents: 0, message: 'No audit records found.' };
    }

    let expectedPreviousHash = GENESIS_HASH;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const expectedSeq = i + 1;

      // 1. Check sequence monotonicity
      if (record.sequenceNumber !== expectedSeq) {
        return {
          valid: false,
          brokenAtSequence: record.sequenceNumber,
          error: `Sequence gap detected. Expected sequence ${expectedSeq}, got ${record.sequenceNumber}.`
        };
      }

      // 2. Check previousHash link
      if (record.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          brokenAtSequence: record.sequenceNumber,
          error: `Broken chain link at sequence ${record.sequenceNumber}. Expected previousHash '${expectedPreviousHash}', got '${record.previousHash}'.`
        };
      }

      // 3. Recalculate eventHash over canonicalData
      const recalculatedHash = AuditService.computeEventHash(record.previousHash, record.canonicalData);
      if (recalculatedHash !== record.eventHash) {
        return {
          valid: false,
          brokenAtSequence: record.sequenceNumber,
          error: `Tampering detected at sequence ${record.sequenceNumber}. Recalculated hash '${recalculatedHash}' does not match stored eventHash '${record.eventHash}'.`
        };
      }

      expectedPreviousHash = record.eventHash;
    }

    return {
      valid: true,
      totalEvents: records.length,
      genesisHash: GENESIS_HASH,
      latestHash: expectedPreviousHash
    };
  }
}

module.exports = {
  AuditService,
  GENESIS_HASH
};

