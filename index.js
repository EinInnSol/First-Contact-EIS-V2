const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { setupRoutes } = require('./server/routes');
const { initializeData } = require('./server/repository');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables with defaults
const config = {
  ADMIN_PIN: process.env.ADMIN_PIN || '4242',
  STAFF_PIN: process.env.STAFF_PIN || '2024',
  AI_ENABLE: process.env.AI_ENABLE === 'true',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  CACHE_TTL_FAQ: parseInt(process.env.CACHE_TTL_FAQ) || 86400,
  CACHE_TTL_TRIAGE: parseInt(process.env.CACHE_TTL_TRIAGE) || 7200,
  CACHE_TTL_ANALYTICS: parseInt(process.env.CACHE_TTL_ANALYTICS) || 900,
  AI_MAX_TOKENS_CHEAP: parseInt(process.env.AI_MAX_TOKENS_CHEAP) || 256,
  AI_MAX_TOKENS_EXPENSIVE: parseInt(process.env.AI_MAX_TOKENS_EXPENSIVE) || 512,
  AI_TEMP: parseFloat(process.env.AI_TEMP) || 0.2
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static('public'));

// Make config available to routes
app.set('config', config);

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize data and seed demo data
initializeData();

// Setup routes
setupRoutes(app);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 First Contact E.I.S. running on port ${PORT}`);
  console.log(`📊 Admin Panel: http://localhost:${PORT}/admin (PIN: ${config.ADMIN_PIN})`);
  console.log(`👥 Staff Dashboard: http://localhost:${PORT}/staff (PIN: ${config.STAFF_PIN})`);
  console.log(`🏥 Resident Intake: http://localhost:${PORT}/onboard`);
  console.log(`🤖 AI Features: ${config.AI_ENABLE ? 'ENABLED' : 'DISABLED (set AI_ENABLE=true to activate)'}`);
});
