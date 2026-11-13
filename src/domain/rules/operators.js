/**
 * Generic Comparison Operators for DecisionFlow Rules Engine
 * Safe dot-notation resolution and null-safe comparisons.
 * ReDoS-free: No regex operators.
 */

function getNestedValue(obj, path) {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

const OPERATORS = {
  EQUALS: (actual, expected) => actual === expected,
  NOT_EQUALS: (actual, expected) => actual !== expected,
  GREATER_THAN: (actual, expected) => {
    if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
    return Number(actual) > Number(expected);
  },
  GREATER_THAN_OR_EQUAL: (actual, expected) => {
    if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
    return Number(actual) >= Number(expected);
  },
  LESS_THAN: (actual, expected) => {
    if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
    return Number(actual) < Number(expected);
  },
  LESS_THAN_OR_EQUAL: (actual, expected) => {
    if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
    return Number(actual) <= Number(expected);
  },
  IN: (actual, expected) => {
    if (actual === null || actual === undefined || !Array.isArray(expected)) return false;
    return expected.includes(actual);
  },
  NOT_IN: (actual, expected) => {
    if (actual === null || actual === undefined || !Array.isArray(expected)) return false;
    return !expected.includes(actual);
  },
  CONTAINS: (actual, expected) => {
    if (typeof actual === 'string' && typeof expected === 'string') {
      return actual.includes(expected);
    }
    if (Array.isArray(actual)) {
      return actual.includes(expected);
    }
    return false;
  },
  EXISTS: (actual) => actual !== undefined && actual !== null,
  IS_NULL: (actual) => actual === null || actual === undefined
};

function evaluateLeafCondition(condition, context) {
  const actualValue = getNestedValue(context, condition.field);
  const operatorFn = OPERATORS[condition.operator];

  if (!operatorFn) {
    throw new Error(`Unsupported comparison operator: ${condition.operator}`);
  }

  const passed = Boolean(operatorFn(actualValue, condition.value));

  return {
    field: condition.field,
    operator: condition.operator,
    expected: condition.value !== undefined ? condition.value : null,
    actual: actualValue !== undefined ? actualValue : null,
    passed
  };
}

module.exports = {
  OPERATORS,
  getNestedValue,
  evaluateLeafCondition
};

