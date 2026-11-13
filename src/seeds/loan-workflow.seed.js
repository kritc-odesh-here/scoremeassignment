const { WorkflowConfigService } = require('../services/workflow-config-service');

const LOAN_APPROVAL_WORKFLOW = {
  workflowId: 'loan_approval',
  version: '1.0.0',
  name: 'Standard Retail Loan Underwriting Workflow',
  description: 'Evaluates applicant financial profile, queries credit bureau, and determines credit approval, rejection, or manual underwriter review.',
  status: 'ACTIVE',
  isPublished: true,
  stages: [
    {
      id: 'bureau_enrichment',
      name: 'Credit Bureau History Lookup',
      type: 'ENRICHMENT',
      handler: 'BureauGateway',
      config: {
        timeoutMs: 3000,
        maxRetries: 3
      }
    },
    {
      id: 'rule_evaluation',
      name: 'Underwriting Policy Evaluation',
      type: 'RULE_EVALUATION',
      handler: 'RulesEngine',
      config: {}
    }
  ],
  ruleset: {
    ruleResolutionStrategy: 'MANDATORY_THEN_FIRST_MATCH',
    defaultOutcome: {
      outcome: 'MANUAL_REVIEW',
      reasonCode: 'POLICY_FALLBACK',
      summary: 'Applicant profile did not match prime or high-risk thresholds; routed for manual review.'
    },
    rules: [
      {
        id: 'SANCTIONS_CLEARANCE',
        name: 'OFAC Sanctions & Watchlist Check',
        priority: 1,
        isMandatory: true,
        condition: {
          field: 'isSanctioned',
          operator: 'NOT_EQUALS',
          value: true
        },
        failureOutcome: {
          outcome: 'REJECTED',
          reasonCode: 'SANCTIONS_COMPLIANCE_BLOCK',
          summary: 'Applicant failed mandatory sanctions screening.'
        },
        action: {
          outcome: 'APPROVED',
          reasonCode: 'SANCTIONS_CLEARED',
          summary: 'Sanctions verified.'
        }
      },
      {
        id: 'RULE_PRIME_AUTO_APPROVAL',
        name: 'Prime Borrower Automated Approval',
        priority: 10,
        condition: {
          combinator: 'AND',
          conditions: [
            { field: 'credit.creditScore', operator: 'GREATER_THAN_OR_EQUAL', value: 720 },
            { field: 'credit.debtToIncome', operator: 'LESS_THAN_OR_EQUAL', value: 0.35 },
            { field: 'credit.bankruptcies', operator: 'EQUALS', value: 0 }
          ]
        },
        action: {
          outcome: 'APPROVED',
          reasonCode: 'PRIME_UNDERWRITING_PASS',
          summary: 'Exceptional credit score (>=720), low debt-to-income (<=35%), and zero bankruptcies.',
          tags: ['AUTO_APPROVED', 'PRIME_TIER']
        }
      },
      {
        id: 'RULE_HIGH_RISK_REJECTION',
        name: 'High Risk Automated Rejection',
        priority: 20,
        condition: {
          combinator: 'OR',
          conditions: [
            { field: 'credit.creditScore', operator: 'LESS_THAN', value: 580 },
            { field: 'credit.debtToIncome', operator: 'GREATER_THAN', value: 0.50 },
            { field: 'credit.bankruptcies', operator: 'GREATER_THAN', value: 0 }
          ]
        },
        action: {
          outcome: 'REJECTED',
          reasonCode: 'HIGH_CREDIT_RISK_POLICY',
          summary: 'Applicant fails minimum risk criteria: credit score < 580, DTI > 50%, or active bankruptcies.',
          tags: ['AUTO_REJECTED', 'SUBPRIME']
        }
      },
      {
        id: 'RULE_NEAR_PRIME_REVIEW',
        name: 'Near Prime Underwriter Review',
        priority: 30,
        condition: {
          combinator: 'AND',
          conditions: [
            { field: 'credit.creditScore', operator: 'GREATER_THAN_OR_EQUAL', value: 580 },
            { field: 'credit.creditScore', operator: 'LESS_THAN', value: 720 }
          ]
        },
        action: {
          outcome: 'MANUAL_REVIEW',
          reasonCode: 'NEAR_PRIME_REVIEW_REQUIRED',
          summary: 'Credit score is within underwriter manual review range (580 - 719).',
          tags: ['MANUAL_UNDERWRITING']
        }
      }
    ]
  }
};

async function seedLoanWorkflow() {
  try {
    const existing = await WorkflowConfigService.getWorkflowVersion('loan_approval', '1.0.0');
    if (existing) {
      return existing;
    }
  } catch (e) {
    // Doesn't exist, proceed to create
  }

  return await WorkflowConfigService.registerWorkflow(LOAN_APPROVAL_WORKFLOW);
}

module.exports = {
  LOAN_APPROVAL_WORKFLOW,
  seedLoanWorkflow
};

