const emailQueue = require('../jobs/email.queue');

async function enqueueEmail(data) {
  return emailQueue.add('send-email', data, {
    jobId: data?.id ? `email-${data.id}` : undefined,
  });
}

module.exports = enqueueEmail;
module.exports.enqueueEmail = enqueueEmail;
