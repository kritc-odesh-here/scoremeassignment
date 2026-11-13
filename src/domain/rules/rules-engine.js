const { evaluateLeafCondition } = require('./operators');
const { RulesetSchema } = require('./schema');

class RulesEngine {
  /**
   * Evaluates a single condition node (leaf or composite) against context data.
   */
  static evaluateCondition(node, context) {
    if ('combinator' in node) {
      const combinator = node.combinator;
      const childResults = [];

      if (combinator === 'AND') {
        let allPassed = true;
        for (const child of node.conditions) {
          const res = RulesEngine.evaluateCondition(child, context);
          childResults.push(res);
          if (!res.passed) {
            allPassed = false;
          }
        }
        return {
          combinator: 'AND',
          passed: allPassed,
          children: childResults
        };
      }

      if (combinator === 'OR') {
        let anyPassed = false;
        for (const child of node.conditions) {
          const res = RulesEngine.evaluateCondition(child, context);
          childResults.push(res);
          if (res.passed) {
            anyPassed = true;
          }
        }
        return {
          combinator: 'OR',
          passed: anyPassed,
          children: childResults
        };
      }

      if (combinator === 'NOT') {
        const child = node.conditions[0];
        const res = RulesEngine.evaluateCondition(child, context);
        return {
          combinator: 'NOT',
          passed: !res.passed,
          children: [res]
        };
      }

      throw new Error(`Unsupported combinator: ${combinator}`);
    }

    return evaluateLeafCondition(node, context);
  }

  /**
   * Sorts rules deterministically by priority (ascending) and ID (ascending tie-breaker).
   */
  static sortRules(rules) {
    return [...rules].sort((a, b) => {
      const pDiff = (a.priority ?? 100) - (b.priority ?? 100);
      if (pDiff !== 0) return pDiff;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /**
   * Evaluates an entire ruleset against context data.
   * Produces an explainable decision with a complete trace of all rules.
   */
  static evaluateRuleset(rulesetConfig, context) {
    const validated = RulesetSchema.parse(rulesetConfig);
    const sorted = RulesEngine.sortRules(validated.rules);

    const mandatoryRules = sorted.filter((r) => r.isMandatory);
    const standardRules = sorted.filter((r) => !r.isMandatory);

    const ruleTraces = [];
    let decision = null;

    // 1. Mandatory Rule Checks
    for (const rule of mandatoryRules) {
      const condTrace = RulesEngine.evaluateCondition(rule.condition, context);
      if (!condTrace.passed) {
        // Mandatory condition failed!
        const failureOutcome = rule.failureOutcome || {
          outcome: 'REJECTED',
          reasonCode: `${rule.id}_MANDATORY_FAILED`,
          summary: `Mandatory check '${rule.name}' failed.`
        };

        ruleTraces.push({
          ruleId: rule.id,
          name: rule.name,
          priority: rule.priority,
          isMandatory: true,
          status: 'MANDATORY_FAILED',
          conditionTrace: condTrace
        });

        decision = {
          outcome: failureOutcome.outcome,
          reasonCode: failureOutcome.reasonCode,
          summary: failureOutcome.summary,
          matchingRuleId: rule.id,
          haltedByMandatory: true
        };
        break;
      } else {
        ruleTraces.push({
          ruleId: rule.id,
          name: rule.name,
          priority: rule.priority,
          isMandatory: true,
          status: 'MANDATORY_PASSED',
          conditionTrace: condTrace
        });
      }
    }

    // If halted by mandatory failure, remaining rules are NOT_EVALUATED
    if (decision) {
      const evaluatedIds = new Set(ruleTraces.map((t) => t.ruleId));
      for (const rule of sorted) {
        if (!evaluatedIds.has(rule.id)) {
          ruleTraces.push({
            ruleId: rule.id,
            name: rule.name,
            priority: rule.priority,
            isMandatory: rule.isMandatory,
            status: 'NOT_EVALUATED',
            reason: `Halted by mandatory check failure in [${decision.matchingRuleId}]`
          });
        }
      }

      return {
        ...decision,
        ruleTraces,
        evaluatedAt: new Date().toISOString()
      };
    }

    // 2. Standard Rule Evaluation (FIRST_MATCH strategy)
    let winningRule = null;
    let shortCircuited = false;

    for (const rule of standardRules) {
      if (shortCircuited) {
        ruleTraces.push({
          ruleId: rule.id,
          name: rule.name,
          priority: rule.priority,
          isMandatory: false,
          status: 'NOT_EVALUATED',
          reason: `Short-circuited by higher-priority match [${winningRule.id}]`
        });
        continue;
      }

      const condTrace = RulesEngine.evaluateCondition(rule.condition, context);
      if (condTrace.passed) {
        winningRule = rule;
        shortCircuited = true;
        ruleTraces.push({
          ruleId: rule.id,
          name: rule.name,
          priority: rule.priority,
          isMandatory: false,
          status: 'MATCHED',
          action: rule.action,
          conditionTrace: condTrace
        });

        decision = {
          outcome: rule.action.outcome,
          reasonCode: rule.action.reasonCode,
          summary: rule.action.summary,
          matchingRuleId: rule.id,
          tags: rule.action.tags || []
        };
      } else {
        ruleTraces.push({
          ruleId: rule.id,
          name: rule.name,
          priority: rule.priority,
          isMandatory: false,
          status: 'EVALUATED_UNMET',
          conditionTrace: condTrace
        });
      }
    }

    // 3. Fallback default outcome if no rules matched
    if (!decision) {
      decision = {
        outcome: validated.defaultOutcome.outcome,
        reasonCode: validated.defaultOutcome.reasonCode,
        summary: validated.defaultOutcome.summary,
        matchingRuleId: null,
        isDefaultOutcome: true
      };
    }

    return {
      ...decision,
      ruleTraces,
      evaluatedAt: new Date().toISOString()
    };
  }
}

module.exports = RulesEngine;

