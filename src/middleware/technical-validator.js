function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: 'TechnicalValidationError',
        message: 'Request payload violated technical schema requirements.',
        issues: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          code: issue.code,
          message: issue.message
        }))
      });
    }

    req.body = result.data;
    next();
  };
}

module.exports = {
  validateBody
};

