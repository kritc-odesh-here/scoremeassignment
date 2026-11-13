const { InvalidStateTransitionError } = require('../domain/state-machine/states');
const { IdempotencyConflictError, IdempotencyPayloadMismatchError } = require('../services/idempotency-service');

function errorHandler(err, req, res, next) {
  // If response headers already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  // State Transition Error (409)
  if (err instanceof InvalidStateTransitionError || err.name === 'InvalidStateTransitionError') {
    return res.status(409).json({
      error: 'InvalidStateTransition',
      message: err.message,
      fromState: err.fromState,
      toState: err.toState
    });
  }

  // Idempotency Errors (409 / 422)
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

  // Workflow Immutability or Version Collision (409)
  if (err.name === 'WorkflowImmutableError' || err.code === 11000) {
    return res.status(409).json({
      error: 'ConflictError',
      message: err.message || 'Resource conflict or duplicate version constraint.'
    });
  }

  // Custom HTTP status if provided
  const statusCode = err.statusCode || (err.status && typeof err.status === 'number' ? err.status : 500);

  res.status(statusCode).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred during workflow execution.'
  });
}

module.exports = {
  errorHandler
};

