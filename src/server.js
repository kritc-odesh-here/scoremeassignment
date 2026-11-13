const { createApp } = require('./app');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { seedLoanWorkflow } = require('./seeds/loan-workflow.seed');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/decisionflow';

async function startServer() {
  try {
    console.log(`Connecting to MongoDB at: ${MONGODB_URI}`);
    await connectDatabase(MONGODB_URI);
    console.log('MongoDB connection established.');

    // Seed default loan underwriting workflow
    console.log('Checking and seeding reference Loan Approval workflow...');
    const wf = await seedLoanWorkflow();
    console.log(`Workflow [${wf.workflowId}@${wf.version}] active and ready.`);

    const app = createApp();

    const server = app.listen(PORT, () => {
      console.log(`DecisionFlow server running at http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
    });

    const shutdown = async () => {
      console.log('Gracefully shutting down DecisionFlow server...');
      server.close(async () => {
        await disconnectDatabase();
        console.log('MongoDB disconnected. Exiting.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error('Fatal error starting DecisionFlow server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer
};

