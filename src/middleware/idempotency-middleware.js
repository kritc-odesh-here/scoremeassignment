const {
  IdempotencyService,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError
} = require('../services/idempotency-service');

function idempotencyFilter(options = {}) {
  const { required = true, leaseDurationMs = 60000 } = options;

  return async (req, res, next) => {
    // Only apply to state-modifying requests (POST, PUT, PATCH)
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    const key = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (!key) {
      if (required) {
        return res.status(400).json({
          error: 'MissingIdempotencyKey',
          message: "Header 'Idempotency-Key' is required for state-modifying requests."
        });
      }
      return next();
    }

    try {
      const lease = await IdempotencyService.acquireLease({
        key,
        method: req.method,
        path: req.originalUrl || req.url,
        body: req.body,
        leaseDurationMs
      });

      if (lease.isCached) {
        res.setHeader('X-Cache-Lookup', 'HIT');
        res.setHeader('Idempotency-Key', key);
        return res.status(lease.statusCode).json(lease.responseBody);
      }

      // New lease acquired
      res.setHeader('X-Cache-Lookup', 'MISS');
      res.setHeader('Idempotency-Key', key);
      req.idempotency = { key: lease.key, ownerToken: lease.ownerToken };

      // Intercept response to commit or release lease
      const originalJson = res.json.bind(res);

      res.json = function (body) {
        const statusCode = res.statusCode;

        // If successful 2xx status, commit completed response
        if (statusCode >= 200 && statusCode < 300) {
          IdempotencyService.commitCompletion(lease.key, lease.ownerToken, statusCode, body).catch((err) => {
            console.error('Failed to commit idempotency key completion:', err);
          });
        } else {
          // If request resulted in client or server error, release lease so it can be retried
          IdempotencyService.releaseLease(lease.key, lease.ownerToken).catch((err) => {
            console.error('Failed to release idempotency key lease:', err);
          });
        }

        return originalJson(body);
      };

      next();
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(409).json({
          error: 'IdempotencyConflict',
          message: err.message
        });
      }

      if (err instanceof IdempotencyPayloadMismatchError) {
        return res.status(422).json({
          error: 'IdempotencyPayloadMismatch',
          message: err.message
        });
      }

      next(err);
    }
  };
}

module.exports = {
  idempotencyFilter
};

