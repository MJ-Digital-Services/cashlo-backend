import express from 'express';
import {
  getAllTypes,
  getAllSlugs,
  getSitemapData,
  getFeatured,
  getBySlug,
  createCalculator,
  updateCalculator,
  deleteCalculator,
  listAllAdmin,
  createCalculatorType,
  updateCalculatorType,
} from '../controllers/calculator.controller.js';
import { protect, restrictTo } from '../middlewares/auth.js';

const router = express.Router();

// Public — consumed by the Next.js frontend
router.get('/types', getAllTypes);
router.get('/slugs', getAllSlugs);
router.get('/sitemap', getSitemapData);
router.get('/featured', getFeatured);
router.get('/:slug', getBySlug);

export default router;

// Admin router, mounted separately in app.js under /admin/calculators
export const adminCalculatorRouter = express.Router();

adminCalculatorRouter.get('/', protect, listAllAdmin);
adminCalculatorRouter.post('/', protect, restrictTo('admin', 'editor'), createCalculator);
adminCalculatorRouter.put('/:id', protect, restrictTo('admin', 'editor'), updateCalculator);
adminCalculatorRouter.delete('/:id', protect, restrictTo('admin'), deleteCalculator);

adminCalculatorRouter.post('/types', protect, restrictTo('admin'), createCalculatorType);
adminCalculatorRouter.put('/types/:id', protect, restrictTo('admin'), updateCalculatorType);