import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import app from './src/app.js';
import { config } from './src/config/environment.js';
import { connectDB } from './src/config/database.js';
import { startReconciliationCron } from './src/jobs/reconcilePayments.job.js';
import { startCmsScheduledPublishCron } from './src/jobs/triggerCmsScheduledPublish.job.js';

connectDB();
startReconciliationCron();
startCmsScheduledPublishCron();

const server = app.listen(config.port, () => {
  console.log(`🚀 Cashlo API running on port ${config.port}`);
});

process.on('SIGTERM', () => {
  server.close(() => console.log('Process terminated'));
});