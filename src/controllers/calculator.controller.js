import Calculator from '../models/Calculator.js';
import CalculatorType from '../models/CalculatorType.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as calculatorService from '../services/calculator.service.js';

// GET /api/v1/calculators/types  → hub page listing (SIP, EMI, SWP, FD, RD cards)
export const getAllTypes = asyncHandler(async (req, res) => {
  const types = await calculatorService.findAllTypes();
  res.status(200).json({ success: true, data: types });
});

// GET /api/v1/calculators/slugs  → for generateStaticParams at build time
export const getAllSlugs = asyncHandler(async (req, res) => {
  const slugs = await calculatorService.findAllSlugs();
  res.status(200).json({ success: true, data: slugs.map((s) => s.slug) });
});

// GET /api/v1/calculators/sitemap  → slug + updatedAt for sitemap-calculators.xml's <lastmod>
export const getSitemapData = asyncHandler(async (req, res) => {
  const items = await calculatorService.findAllForSitemap();
  res.status(200).json({
    success: true,
    data: items.map((c) => ({ slug: c.slug, updatedAt: c.updatedAt })),
  });
});

// GET /api/v1/calculators/featured  → for nav dropdown / sidebar "Popular Calculators"
export const getFeatured = asyncHandler(async (req, res) => {
  const items = await calculatorService.findFeatured();
  res.status(200).json({ success: true, data: items });
});

// GET /api/v1/calculators/:slug  → the actual page data (base type OR bank variant)
export const getBySlug = asyncHandler(async (req, res) => {
  const calculator = await calculatorService.findBySlug(req.params.slug);

  if (!calculator) {
    return res.status(404).json({ success: false, message: 'Calculator not found' });
  }

  const variants = await calculatorService.findVariantsByType(
    calculator.calculatorType._id,
    calculator.slug
  );

  res.status(200).json({ success: true, data: { calculator, variants } });
});

// ── Admin (protected) ──────────────────────────────────────────

export const createCalculator = asyncHandler(async (req, res) => {
  const calculator = await Calculator.create(req.body);
  res.status(201).json({ success: true, data: calculator });
});

export const updateCalculator = asyncHandler(async (req, res) => {
  const calculator = await Calculator.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!calculator) {
    return res.status(404).json({ success: false, message: 'Calculator not found' });
  }

  res.status(200).json({ success: true, data: calculator });
});

export const deleteCalculator = asyncHandler(async (req, res) => {
  const calculator = await Calculator.findByIdAndDelete(req.params.id);

  if (!calculator) {
    return res.status(404).json({ success: false, message: 'Calculator not found' });
  }

  res.status(200).json({ success: true, message: 'Calculator deleted' });
});

export const listAllAdmin = asyncHandler(async (req, res) => {
  const calculators = await Calculator.find()
    .populate('calculatorType', 'key name')
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, data: calculators });
});

// ── Admin: Calculator Types ────────────────────────────────────

export const createCalculatorType = asyncHandler(async (req, res) => {
  const type = await CalculatorType.create(req.body);
  res.status(201).json({ success: true, data: type });
});

export const updateCalculatorType = asyncHandler(async (req, res) => {
  const type = await CalculatorType.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!type) {
    return res.status(404).json({ success: false, message: 'Calculator type not found' });
  }

  res.status(200).json({ success: true, data: type });
});