const express = require('express');
const mongoose = require('mongoose');
const { isReplicaSet } = require('../config/database');

const router = express.Router();

router.get('/', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED';

  res.json({
    status: 'UP',
    service: 'DecisionFlow',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      status: dbStatus,
      isReplicaSet: isReplicaSet()
    }
  });
});

module.exports = router;

