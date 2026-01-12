import express from 'express';
import cors from 'cors';
import http from 'http';
import sessionRoutes from './routes/sessionRoutes.js';
import { config } from './utils/config.js';

const app = express();
const PORT = process.env.PORT || config.server.port;

// CORS with preflight cache
app.use(cors({
  origin: true,
  credentials: true,
  maxAge: 86400, // Preflight cache 24 hours
}));

app.use(express.json());

// Keep-alive header for all responses
app.use((_req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=120, max=1000');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/sessions', sessionRoutes);

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server with keep-alive settings
const server = http.createServer(app);
server.keepAliveTimeout = 120000; // 120 seconds
server.headersTimeout = 125000; // Slightly higher than keepAliveTimeout

server.listen(PORT, () => {
  console.log(`Claude Web Shell Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`PTY backend: ${config.pty.useConpty ? 'ConPTY' : 'winpty'}`);
  console.log('Keep-alive enabled: timeout=120s');
});
