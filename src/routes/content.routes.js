import express from 'express';
import { uploadBlogImage, uploadBlogPdf } from '../controllers/content.controller.js';
import { protect, restrictTo } from '../middlewares/auth.js';
import { uploadBlogImageFile, uploadPdf } from '../middlewares/upload.js';

const router = express.Router();

router.use(protect);
router.use(restrictTo('admin', 'editor'));

router.post('/upload/blog-image', uploadBlogImageFile.single('image'), uploadBlogImage);
router.post('/upload/blog-pdf', uploadPdf.single('pdf'), uploadBlogPdf);

export default router;