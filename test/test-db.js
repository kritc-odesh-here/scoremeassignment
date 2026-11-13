const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let replSet = null;

// Allow sufficient time for in-memory replica set spin-up on Windows
jest.setTimeout(60000);

async function setupTestDB() {
  if (!replSet) {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 }
    });
  }
  const uri = replSet.getUri('decisionflow_test');
  await mongoose.connect(uri);
}

async function teardownTestDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
}

async function clearTestDB() {
  if (mongoose.connection.readyState !== 0) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}

module.exports = {
  setupTestDB,
  teardownTestDB,
  clearTestDB
};
