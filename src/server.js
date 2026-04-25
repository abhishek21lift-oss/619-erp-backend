const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 5000;

// Security
app.use(helmet({ contentSecurityPolicy: false }));

// ✅ FIXED CORS
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://619-erp-frontend.vercel.app'
  ],
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ✅ IMPORTANT
app.options('*', cors());

// Body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30
});

app.use('/api/', apiLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/reports', require('./routes/reports'));

// ✅ FIXED (correct usage)
app.use('/api/auth/login', loginLimiter);

// 404
app.use('/api/*', (req, res) =>
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` })
);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 API running on ${PORT}`);
});