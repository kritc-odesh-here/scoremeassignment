const mongoose = require('mongoose');

let isReplica = false;

async function connectDatabase(uri) {
  const mongoUri = uri || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/decisionflow';
  await mongoose.connect(mongoUri);

  try {
    const admin = mongoose.connection.db.admin();
    const status = await admin.command({ isMaster: 1 });
    isReplica = Boolean(status.setName);
  } catch (err) {
    isReplica = false;
  }

  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

function isReplicaSet() {
  return isReplica;
}

/**
 * Executes work within a MongoDB Client Session transaction when supported,
 * or gracefully runs with a standalone session fallback.
 */
async function withTransaction(workFn) {
  const session = await mongoose.startSession();
  try {
    if (isReplica) {
      let result;
      await session.withTransaction(async () => {
        result = await workFn(session);
      });
      return result;
    } else {
      // Standalone MongoDB without replica set
      return await workFn(session);
    }
  } finally {
    await session.endSession();
  }
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  isReplicaSet,
  withTransaction
};

