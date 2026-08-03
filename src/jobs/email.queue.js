const { Queue } = require('bullmq');
const redis = require('../lib/redis');

const emailQueue = new Queue('email', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: 100,
  },
});

module.exports = emailQueue;
