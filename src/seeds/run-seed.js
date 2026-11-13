const { connectDatabase, disconnectDatabase } = require('../config/database');
const { seedLoanWorkflow } = require('./loan-workflow.seed');

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/decisionflow';
  console.log(`Connecting to MongoDB at: ${uri}`);
  await connectDatabase(uri);

  console.log('Seeding reference Loan Approval workflow...');
  const wf = await seedLoanWorkflow();
  console.log(`Workflow [${wf.workflowId}@${wf.version}] seeded successfully! Status: ${wf.status}`);

  await disconnectDatabase();
  console.log('Database disconnected.');
}

run().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});

