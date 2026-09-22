import Calculator from '../models/Calculator.js';
import CalculatorType from '../models/CalculatorType.js';

export const findAllTypes = async () => {
  return CalculatorType.find({ isActive: true }).sort({ order: 1 });
};

export const findBySlug = async (slug) => {
  return Calculator.findOne({ slug, isActive: true }).populate('calculatorType');
};

export const findVariantsByType = async (calculatorTypeId, excludeSlug) => {
  return Calculator.find({
    calculatorType: calculatorTypeId,
    isBankVariant: true,
    isActive: true,
    slug: { $ne: excludeSlug },
  })
    .select('slug title bankName logo')
    .sort({ bankName: 1 });
};

export const findFeatured = async (limit = 10) => {
  return Calculator.find({ isActive: true, isFeatured: true })
    .select('slug title bankName isBankVariant')
    .populate('calculatorType', 'key name')
    .limit(limit);
};

export const findAllSlugs = async () => {
  return Calculator.find({ isActive: true }).select('slug -_id');
};

export const findAllForSitemap = async () => {
  return Calculator.find({ isActive: true }).select('slug updatedAt -_id');
};