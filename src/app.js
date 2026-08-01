import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { errorHandler } from './middlewares/errorHandler.js';
import authRoutes from './routes/auth.routes.js';
import calculatorRoutes, { adminCalculatorRouter } from './routes/calculator.routes.js';
import blogRoutes from './routes/blog.routes.js';
import categoryRoutes from './routes/category.routes.js';
import contentRoutes from './routes/content.routes.js';
import distributorRoutes from './routes/distributor.routes.js';
import distributorAdminRoutes from './routes/distributorAdmin.routes.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'Cashlo API running...' });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/calculators', calculatorRoutes);
app.use('/api/v1/admin/calculators', adminCalculatorRouter);
app.use('/api/v1/blogs', blogRoutes);
app.use('/api/v1/admin/blogs', blogRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/admin/categories', categoryRoutes);
app.use('/api/v1/admin/content', contentRoutes);
app.use('/api/v1/distributor', distributorRoutes);
app.use('/api/v1/admin/distributor', distributorAdminRoutes);

app.use(errorHandler);

export default app;