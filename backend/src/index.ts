// Main Application Entry Point
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import dotenv from 'dotenv';
import client from 'prom-client';
import routes from './routes';
import { errorHandler } from './middleware/errorHandler';
import { swaggerSpec } from './config/swagger';
import prisma from './config/database';

// Load environment variables
//test build stg
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Reverse proxy (ingress-nginx) ──
// Backend nằm sau ingress-nginx (route /api) → cần trust proxy để
// express-rate-limit + IP client hoạt động đúng với header X-Forwarded-For.
app.set('trust proxy', 1);

// ── Prometheus metrics (RED: Rate / Errors / Duration) ──
client.collectDefaultMetrics();
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// ── Middleware ─────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Ghi nhận duration + status mỗi request (nguồn tính error-rate, p95)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    httpRequestDuration.labels(req.method, route, String(res.statusCode)).observe(durationSeconds);
  });
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // nâng từ 100 → đủ cho traffic generator (30 req/phút = 450/15min)
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ── API Routes ─────────────────────────────────────────
app.use('/api', routes);

// ── Swagger Docs ───────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'E-Commerce API Docs',
}));

// ── Root ───────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'E-Commerce API',
    version: '1.0.0',
    docs: '/api-docs',
    health: '/api/health',
  });
});

// ── Metrics (Prometheus scrape) ────────────────────────
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end(err instanceof Error ? err.message : 'metrics error');
  }
});

// ── Error Handler ──────────────────────────────────────
app.use(errorHandler);

// ── Start Server ───────────────────────────────────────
const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📚 API Docs: http://localhost:${PORT}/api-docs`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  console.log('👋 Server shut down gracefully');
  process.exit(0);
});

export default app;
