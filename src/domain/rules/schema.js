const { z } = require('zod');

const ComparisonOperatorEnum = z.enum([
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'IN',
  'NOT_IN',
  'CONTAINS',
  'EXISTS',
  'IS_NULL'
]);

const OutcomeEnum = z.enum(['APPROVED', 'REJECTED', 'MANUAL_REVIEW']);

const LeafConditionSchema = z.object({
  field: z.string().min(1, 'Field path is required'),
  operator: ComparisonOperatorEnum,
  value: z.any().optional()
});

const RuleConditionSchema = z.lazy(() =>
  z.union([
    LeafConditionSchema,
    z.object({
      combinator: z.enum(['AND', 'OR', 'NOT']),
      conditions: z.array(RuleConditionSchema).min(1, 'Conditions array cannot be empty')
    }).superRefine((data, ctx) => {
      if (data.combinator === 'NOT' && data.conditions.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'NOT combinator must have exactly 1 child condition',
          path: ['conditions']
        });
      }
    })
  ])
);

const RuleActionSchema = z.object({
  outcome: OutcomeEnum,
  reasonCode: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).default([])
});

const FailureOutcomeSchema = z.object({
  outcome: OutcomeEnum,
  reasonCode: z.string().min(1),
  summary: z.string().min(1)
});

const RuleDefinitionSchema = z.object({
  id: z.string().min(1, 'Rule ID is required'),
  name: z.string().min(1, 'Rule name is required'),
  description: z.string().optional(),
  priority: z.number().int().default(100),
  isMandatory: z.boolean().default(false),
  failureOutcome: FailureOutcomeSchema.optional(),
  condition: RuleConditionSchema,
  action: RuleActionSchema
});

const RulesetSchema = z.object({
  rules: z.array(RuleDefinitionSchema),
  ruleResolutionStrategy: z.enum(['FIRST_MATCH', 'MANDATORY_THEN_FIRST_MATCH']).default('MANDATORY_THEN_FIRST_MATCH'),
  defaultOutcome: z.object({
    outcome: OutcomeEnum.default('MANUAL_REVIEW'),
    reasonCode: z.string().default('NO_RULES_MATCHED'),
    summary: z.string().default('No rule conditions were satisfied; defaulted to manual review.')
  })
});

module.exports = {
  ComparisonOperatorEnum,
  OutcomeEnum,
  LeafConditionSchema,
  RuleConditionSchema,
  RuleActionSchema,
  FailureOutcomeSchema,
  RuleDefinitionSchema,
  RulesetSchema
};

