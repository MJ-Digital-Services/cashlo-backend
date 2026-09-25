import express from 'express';
import {
  listLeads,
  exportLeads,
  getLead,
  updateLeadCallStatus,
  updateIdCreated,
  approvePayment,
  rejectPayment,
  markRefunded,
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
router.patch('/leads/:id/approve-payment', approvePayment);
router.patch('/leads/:id/reject-payment', rejectPayment);
router.patch('/leads/:id/mark-refunded', markRefunded);

export default router;
