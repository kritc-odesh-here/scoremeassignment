const RulesEngine = require('../../src/domain/rules/rules-engine');
const { RulesetSchema } = require('../../src/domain/rules/schema');

describe('Generic AST Rules Engine', () => {
  describe('Leaf Condition Operators', () => {
    test('EQUALS and NOT_EQUALS', () => {
      const condition = { field: 'user.role', operator: 'EQUALS', value: 'ADMIN' };
      expect(RulesEngine.evaluateCondition(condition, { user: { role: 'ADMIN' } }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(condition, { user: { role: 'GUEST' } }).passed).toBe(false);

      const notEq = { field: 'user.status', operator: 'NOT_EQUALS', value: 'BANNED' };
      expect(RulesEngine.evaluateCondition(notEq, { user: { status: 'ACTIVE' } }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(notEq, { user: { status: 'BANNED' } }).passed).toBe(false);
    });

    test('Numeric comparisons (GT, GTE, LT, LTE)', () => {
      const gte = { field: 'credit.score', operator: 'GREATER_THAN_OR_EQUAL', value: 700 };
      expect(RulesEngine.evaluateCondition(gte, { credit: { score: 750 } }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(gte, { credit: { score: 700 } }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(gte, { credit: { score: 699 } }).passed).toBe(false);
      expect(RulesEngine.evaluateCondition(gte, { credit: {} }).passed).toBe(false); // safe missing field
    });

    test('Collection operators (IN, NOT_IN, CONTAINS)', () => {
      const inCond = { field: 'country', operator: 'IN', value: ['US', 'CA', 'GB'] };
      expect(RulesEngine.evaluateCondition(inCond, { country: 'US' }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(inCond, { country: 'FR' }).passed).toBe(false);

      const containsCond = { field: 'tags', operator: 'CONTAINS', value: 'VIP' };
      expect(RulesEngine.evaluateCondition(containsCond, { tags: ['NEW', 'VIP', 'PRO'] }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(containsCond, { tags: ['NEW'] }).passed).toBe(false);
    });

    test('Null safety and existence (EXISTS, IS_NULL)', () => {
      const existsCond = { field: 'email', operator: 'EXISTS' };
      expect(RulesEngine.evaluateCondition(existsCond, { email: 'a@b.com' }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(existsCond, {}).passed).toBe(false);

      const isNullCond = { field: 'deletedAt', operator: 'IS_NULL' };
      expect(RulesEngine.evaluateCondition(isNullCond, { deletedAt: null }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(isNullCond, {}).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(isNullCond, { deletedAt: '2026-01-01' }).passed).toBe(false);
    });
  });

  describe('Composite Conditions (AND, OR, NOT)', () => {
    test('AND combinator requires all conditions to pass', () => {
      const condition = {
        combinator: 'AND',
        conditions: [
          { field: 'score', operator: 'GREATER_THAN_OR_EQUAL', value: 700 },
          { field: 'dti', operator: 'LESS_THAN_OR_EQUAL', value: 0.35 }
        ]
      };

      expect(RulesEngine.evaluateCondition(condition, { score: 720, dti: 0.30 }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(condition, { score: 720, dti: 0.45 }).passed).toBe(false);
      expect(RulesEngine.evaluateCondition(condition, { score: 650, dti: 0.20 }).passed).toBe(false);
    });

    test('OR combinator passes if at least one condition passes', () => {
      const condition = {
        combinator: 'OR',
        conditions: [
          { field: 'income', operator: 'GREATER_THAN_OR_EQUAL', value: 100000 },
          { field: 'hasGuarantor', operator: 'EQUALS', value: true }
        ]
      };

      expect(RulesEngine.evaluateCondition(condition, { income: 120000, hasGuarantor: false }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(condition, { income: 40000, hasGuarantor: true }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(condition, { income: 40000, hasGuarantor: false }).passed).toBe(false);
    });

    test('NOT combinator inverts the child condition', () => {
      const condition = {
        combinator: 'NOT',
        conditions: [
          { field: 'isBankrupt', operator: 'EQUALS', value: true }
        ]
      };

      expect(RulesEngine.evaluateCondition(condition, { isBankrupt: false }).passed).toBe(true);
      expect(RulesEngine.evaluateCondition(condition, { isBankrupt: true }).passed).toBe(false);
    });

    test('Schema enforces exactly 1 child for NOT combinator', () => {
      expect(() => {
        RulesetSchema.parse({
          rules: [
            {
              id: 'R1',
              name: 'Invalid NOT',
              condition: {
                combinator: 'NOT',
                conditions: [
                  { field: 'a', operator: 'EQUALS', value: 1 },
                  { field: 'b', operator: 'EQUALS', value: 2 }
                ]
              },
              action: { outcome: 'APPROVED', reasonCode: 'OK', summary: 'OK' }
            }
          ],
          defaultOutcome: { outcome: 'MANUAL_REVIEW', reasonCode: 'DEFAULT', summary: 'DEFAULT' }
        });
      }).toThrow(/NOT combinator must have exactly 1 child condition/);
    });
  });

  describe('Ruleset Resolution, Priority, and Ties', () => {
    const sampleRuleset = {
      ruleResolutionStrategy: 'MANDATORY_THEN_FIRST_MATCH',
      defaultOutcome: {
        outcome: 'MANUAL_REVIEW',
        reasonCode: 'DEFAULT_REVIEW',
        summary: 'Application requires manual underwriting.'
      },
      rules: [
        {
          id: 'RULE_PRIME',
          name: 'Prime Auto-Approval',
          priority: 10,
          condition: {
            combinator: 'AND',
            conditions: [
              { field: 'score', operator: 'GREATER_THAN_OR_EQUAL', value: 720 },
              { field: 'dti', operator: 'LESS_THAN_OR_EQUAL', value: 0.35 }
            ]
          },
          action: {
            outcome: 'APPROVED',
            reasonCode: 'PRIME_AUTO_PASS',
            summary: 'Excellent credit score and low debt-to-income.',
            tags: ['PRIME']
          }
        },
        {
          id: 'RULE_SUBPRIME_REJECT',
          name: 'High Risk Auto-Reject',
          priority: 20,
          condition: {
            field: 'score',
            operator: 'LESS_THAN',
            value: 580
          },
          action: {
            outcome: 'REJECTED',
            reasonCode: 'HIGH_CREDIT_RISK',
            summary: 'Credit score below minimum underwriting threshold.'
          }
        },
        {
          id: 'RULE_NEAR_PRIME_REVIEW',
          name: 'Near Prime Review',
          priority: 30,
          condition: {
            field: 'score',
            operator: 'GREATER_THAN_OR_EQUAL',
            value: 650
          },
          action: {
            outcome: 'MANUAL_REVIEW',
            reasonCode: 'BORDERLINE_CREDIT',
            summary: 'Credit score in review range.'
          }
        }
      ]
    };

    test('Matches highest priority rule and short-circuits lower priority rules', () => {
      const result = RulesEngine.evaluateRuleset(sampleRuleset, { score: 750, dti: 0.28 });
      expect(result.outcome).toBe('APPROVED');
      expect(result.matchingRuleId).toBe('RULE_PRIME');

      const traces = result.ruleTraces;
      expect(traces[0].status).toBe('MATCHED');
      expect(traces[1].status).toBe('NOT_EVALUATED');
      expect(traces[1].reason).toContain('Short-circuited by higher-priority match');
      expect(traces[2].status).toBe('NOT_EVALUATED');
    });

    test('Evaluates second rule if first rule fails', () => {
      const result = RulesEngine.evaluateRuleset(sampleRuleset, { score: 540, dti: 0.20 });
      expect(result.outcome).toBe('REJECTED');
      expect(result.matchingRuleId).toBe('RULE_SUBPRIME_REJECT');

      const traces = result.ruleTraces;
      expect(traces[0].status).toBe('EVALUATED_UNMET');
      expect(traces[1].status).toBe('MATCHED');
      expect(traces[2].status).toBe('NOT_EVALUATED');
    });

    test('Falls back to default outcome if no rules match', () => {
      const result = RulesEngine.evaluateRuleset(sampleRuleset, { score: 600, dti: 0.50 });
      expect(result.outcome).toBe('MANUAL_REVIEW');
      expect(result.reasonCode).toBe('DEFAULT_REVIEW');
      expect(result.isDefaultOutcome).toBe(true);
    });

    test('Deterministic tie-breaker by rule ID when priorities are equal', () => {
      const tiedRuleset = {
        defaultOutcome: { outcome: 'MANUAL_REVIEW', reasonCode: 'DEF', summary: 'DEF' },
        rules: [
          {
            id: 'B_RULE',
            name: 'Rule B',
            priority: 10,
            condition: { field: 'v', operator: 'EQUALS', value: 1 },
            action: { outcome: 'REJECTED', reasonCode: 'B_HIT', summary: 'B' }
          },
          {
            id: 'A_RULE',
            name: 'Rule A',
            priority: 10,
            condition: { field: 'v', operator: 'EQUALS', value: 1 },
            action: { outcome: 'APPROVED', reasonCode: 'A_HIT', summary: 'A' }
          }
        ]
      };

      const sorted = RulesEngine.sortRules(tiedRuleset.rules);
      expect(sorted[0].id).toBe('A_RULE');
      expect(sorted[1].id).toBe('B_RULE');

      const result = RulesEngine.evaluateRuleset(tiedRuleset, { v: 1 });
      expect(result.matchingRuleId).toBe('A_RULE');
      expect(result.outcome).toBe('APPROVED');
    });
  });

  describe('Configurable Mandatory Rules', () => {
    test('Failing mandatory rule triggers configured failure outcome and halts execution', () => {
      const rulesetWithMandatory = {
        defaultOutcome: { outcome: 'MANUAL_REVIEW', reasonCode: 'DEF', summary: 'DEF' },
        rules: [
          {
            id: 'SANCTIONS_CHECK',
            name: 'Sanctions Clearance',
            isMandatory: true,
            condition: {
              field: 'isSanctioned',
              operator: 'EQUALS',
              value: false
            },
            failureOutcome: {
              outcome: 'MANUAL_REVIEW', // Configurable outcome, not hardcoded rejection!
              reasonCode: 'SANCTIONS_SUSPECT',
              summary: 'Requires compliance officer review.'
            },
            action: { outcome: 'APPROVED', reasonCode: 'OK', summary: 'OK' }
          },
          {
            id: 'RULE_PRIME',
            name: 'Prime Approval',
            priority: 1,
            condition: { field: 'score', operator: 'GREATER_THAN', value: 700 },
            action: { outcome: 'APPROVED', reasonCode: 'PRIME', summary: 'Prime' }
          }
        ]
      };

      const result = RulesEngine.evaluateRuleset(rulesetWithMandatory, { isSanctioned: true, score: 800 });
      expect(result.outcome).toBe('MANUAL_REVIEW');
      expect(result.reasonCode).toBe('SANCTIONS_SUSPECT');
      expect(result.haltedByMandatory).toBe(true);

      const traces = result.ruleTraces;
      expect(traces[0].status).toBe('MANDATORY_FAILED');
      expect(traces[1].status).toBe('NOT_EVALUATED');
      expect(traces[1].reason).toContain('Halted by mandatory check failure');
    });
  });
});

