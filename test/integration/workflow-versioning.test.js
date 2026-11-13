const { setupTestDB, teardownTestDB, clearTestDB } = require('../test-db');
const { WorkflowConfigService, WorkflowImmutableError } = require('../../src/services/workflow-config-service');
const WorkflowDefinitionModel = require('../../src/models/workflow-definition.model');

describe('Workflow Versioning & Immutability Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDB();
  }, 60000);

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    await WorkflowDefinitionModel.syncIndexes();
  });

  const baseWorkflow = {
    workflowId: 'mortgage_underwriting',
    version: '1.0.0',
    name: 'Mortgage Workflow V1',
    status: 'ACTIVE',
    isPublished: true,
    stages: [
      { id: 'eval', name: 'Eval', type: 'RULE_EVALUATION', handler: 'RulesEngine' }
    ],
    ruleset: {
      defaultOutcome: { outcome: 'MANUAL_REVIEW', reasonCode: 'DEF', summary: 'DEF' },
      rules: [
        {
          id: 'R1',
          name: 'Rule 1',
          condition: { field: 'income', operator: 'GREATER_THAN', value: 50000 },
          action: { outcome: 'APPROVED', reasonCode: 'PASS', summary: 'PASS' }
        }
      ]
    }
  };

  test('Registers published workflow version', async () => {
    const created = await WorkflowConfigService.registerWorkflow(baseWorkflow);
    expect(created._id).toBeDefined();
    expect(created.version).toBe('1.0.0');
    expect(created.status).toBe('ACTIVE');
  });

  test('Prevents modification of published workflow versions (Immutability)', async () => {
    await WorkflowConfigService.registerWorkflow(baseWorkflow);

    await expect(
      WorkflowConfigService.updateWorkflow('mortgage_underwriting', '1.0.0', {
        name: 'Attempted Malicious Override'
      })
    ).rejects.toThrow(WorkflowImmutableError);
  });

  test('Enforces strictly ONE ACTIVE version per workflowId at the database level', async () => {
    await WorkflowConfigService.registerWorkflow(baseWorkflow);

    // Attempting to insert another ACTIVE document for the same workflowId directly should trigger partial index collision
    await expect(
      WorkflowDefinitionModel.create({
        ...baseWorkflow,
        version: '2.0.0',
        status: 'ACTIVE' // Violates partial unique index!
      })
    ).rejects.toThrow(/E11000/);
  });

  test('Atomically activates a new version while deprecating previous active version', async () => {
    await WorkflowConfigService.registerWorkflow(baseWorkflow);

    // Register v2.0.0 in DRAFT state
    await WorkflowConfigService.registerWorkflow({
      ...baseWorkflow,
      version: '2.0.0',
      status: 'DRAFT',
      isPublished: false
    });

    // Activate v2.0.0
    const activated = await WorkflowConfigService.activateWorkflowVersion('mortgage_underwriting', '2.0.0');
    expect(activated.version).toBe('2.0.0');
    expect(activated.status).toBe('ACTIVE');
    expect(activated.isPublished).toBe(true);

    // Check that v1.0.0 is now DEPRECATED
    const oldV1 = await WorkflowConfigService.getWorkflowVersion('mortgage_underwriting', '1.0.0');
    expect(oldV1.status).toBe('DEPRECATED');

    // Check active lookup returns v2.0.0
    const active = await WorkflowConfigService.getActiveWorkflow('mortgage_underwriting');
    expect(active.version).toBe('2.0.0');
  });
});
