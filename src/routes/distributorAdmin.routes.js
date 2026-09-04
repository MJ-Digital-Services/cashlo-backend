import express from 'express';
import {
  listLeads,
  exportLeads,
  getLead,
  updateLeadCallStatus,
  updateIdCreated,
  listWebhookLogs,
  markLeadPaidManually,
  cancelManualLead,
  approveUtr,
  rejectUtr,
  approveFinalUtr,
  rejectFinalUtr,
} from '../controllers/distributorAdmin.controller.js';
import { protect, restrictTo } from '../middlewares/auth.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin', 'sales'));

router.get('/leads', listLeads);
router.get('/leads/export', exportLeads);
router.get('/leads/:id', getLead);
router.patch('/leads/:id/call-status', updateLeadCallStatus);
router.patch('/leads/:id/id-created', updateIdCreated);
router.patch('/leads/:id/mark-paid', markLeadPaidManually);
router.patch('/leads/:id/cancel', cancelManualLead);
router.patch('/leads/:id/approve-utr', approveUtr);
router.patch('/leads/:id/reject-utr', rejectUtr);
router.patch('/leads/:id/approve-final-utr', approveFinalUtr);
router.patch('/leads/:id/reject-final-utr', rejectFinalUtr);


router.get('/webhook-logs', listWebhookLogs);

export default router;