/**
 * Simulated Credit Bureau External Dependency
 * Supports:
 * - Deterministic external idempotency store (prevents duplicate charges on retry/resumption)
 * - Fault injection: transient 503s, timeouts, fail N times then succeed
 * - Exponential backoff with full jitter
 */

class ExternalServiceError extends Error {
  constructor(message, statusCode = 500, isTransient = true) {
    super(message);
    this.name = 'ExternalServiceError';
    this.statusCode = statusCode;
    this.isTransient = isTransient;
  }
}

class BureauGateway {
  constructor(options = {}) {
    this.idempotencyStore = new Map(); // token -> { response, createdAt, callCount }
    this.failureCounters = new Map(); // token -> count of attempts

    // Configurable fault injection defaults
    this.defaultOptions = {
      baseBackoffMs: 50,
      maxBackoffMs: 1000,
      maxRetries: 3,
      ...options
    };
  }

  /**
   * Resets stores (for testing isolation)
   */
  reset() {
    this.idempotencyStore.clear();
    this.failureCounters.clear();
  }

  /**
   * Calculates jittered exponential backoff
   */
  static calculateBackoff(attempt, baseMs = 50, maxMs = 1000) {
    const exponential = baseMs * Math.pow(2, attempt);
    const ceiling = Math.min(maxMs, exponential);
    return Math.floor(Math.random() * ceiling);
  }

  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generates mock credit profile based on applicant nationalId or income
   */
  static generateCreditProfile(applicant) {
    const ssn = applicant.nationalId || '';
    const income = applicant.annualIncome || 50000;
    const requested = applicant.requestedAmount || 10000;

    // Deterministic generation for repeatable tests
    if (ssn.includes('SUBPRIME') || ssn.includes('000-00-0000')) {
      return {
        creditScore: 520,
        debtToIncome: 0.58,
        bankruptcies: 1,
        activeTradelines: 3,
        bureauReference: `BUR-SUB-${Date.now()}`
      };
    }

    if (ssn.includes('REVIEW') || ssn.includes('555-55-5555')) {
      return {
        creditScore: 640,
        debtToIncome: 0.38,
        bankruptcies: 0,
        activeTradelines: 5,
        bureauReference: `BUR-REV-${Date.now()}`
      };
    }

    // Default: Prime Profile
    const estimatedDti = requested / (income * 0.4 || 1);
    const dti = Math.min(0.32, Math.max(0.15, Number(estimatedDti.toFixed(2))));
    return {
      creditScore: 740,
      debtToIncome: dti,
      bankruptcies: 0,
      activeTradelines: 8,
      bureauReference: `BUR-PRIME-${Date.now()}`
    };
  }

  /**
   * Executes a simulated external call with fault injection and external idempotency
   */
  async fetchCreditReport(applicant, idempotencyToken, faultConfig = {}) {
    if (!idempotencyToken) {
      throw new Error('idempotencyToken is required for external BureauGateway calls');
    }

    // 1. Check external idempotency store
    if (this.idempotencyStore.has(idempotencyToken)) {
      const stored = this.idempotencyStore.get(idempotencyToken);
      return {
        ...stored.response,
        isReplay: true,
        callCount: stored.callCount
      };
    }

    const {
      failureMode = 'NONE', // 'NONE' | 'FAIL_N_TIMES' | 'ALWAYS_FAIL' | 'PERMANENT_FAIL'
      failTimes = 2,
      maxRetries = this.defaultOptions.maxRetries,
      baseBackoffMs = this.defaultOptions.baseBackoffMs,
      maxBackoffMs = this.defaultOptions.maxBackoffMs
    } = faultConfig;

    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        // Evaluate simulated faults
        if (failureMode === 'PERMANENT_FAIL') {
          throw new ExternalServiceError('Bureau service returned 400 Bad Request: Invalid national ID format.', 400, false);
        }

        if (failureMode === 'ALWAYS_FAIL') {
          throw new ExternalServiceError('Credit Bureau service unavailable (503).', 503, true);
        }

        if (failureMode === 'FAIL_N_TIMES') {
          const currentAttempts = (this.failureCounters.get(idempotencyToken) || 0) + 1;
          this.failureCounters.set(idempotencyToken, currentAttempts);

          if (currentAttempts <= failTimes) {
            throw new ExternalServiceError(`Credit Bureau service 503 Service Unavailable (attempt ${currentAttempts}/${failTimes}).`, 503, true);
          }
        }

        // External Operation Succeeded!
        const profile = BureauGateway.generateCreditProfile(applicant);
        const result = {
          success: true,
          profile,
          fetchedAt: new Date().toISOString()
        };

        // Persist in external idempotency store
        this.idempotencyStore.set(idempotencyToken, {
          response: result,
          createdAt: new Date(),
          callCount: attempt + 1
        });

        return {
          ...result,
          isReplay: false,
          totalAttempts: attempt + 1
        };
      } catch (err) {
        attempt++;

        // If non-transient or retries exhausted, rethrow
        if (!err.isTransient || attempt > maxRetries) {
          err.attempts = attempt;
          throw err;
        }

        // Exponential backoff with jitter
        const sleepMs = BureauGateway.calculateBackoff(attempt, baseBackoffMs, maxBackoffMs);
        await BureauGateway.sleep(sleepMs);
      }
    }
  }
}

module.exports = {
  BureauGateway,
  ExternalServiceError
};

