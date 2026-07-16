
Server · JS
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
 
const jobsRouter = require('./src/routes/jobs');
const providersRouter = require('./src/routes/providers');
const categoriesRouter = require('./src/routes/categories');
const authRouter = require('./src/routes/auth');
const { setupWebSocket } = require('./src/websocket');
const { startOfferExpiryWorker } = require('./src/workers/offerExpiryWorker');
 
if (!process.env.JWT_SECRET) {
  console.warn(
    'WARNING: JWT_SECRET is not set. Using an insecure default — set a real ' +
    'JWT_SECRET environment variable before this goes anywhere near production.'
  );
}
 
const app = express();
// Open CORS so the customer/provider apps (which may run from any origin —
// e.g. an artifact preview, localhost, a deployed frontend) can call this
// API directly from the browser. Restrict `origin` to your real frontend
// domain(s) before this goes anywhere near production.
app.use(cors());
app.use(express.json());
 
const httpServer = http.createServer(app);
const io = setupWebSocket(httpServer);
 
app.use('/auth', authRouter());
app.use('/jobs', jobsRouter(io));
app.use('/providers', providersRouter());
app.use('/categories', categoriesRouter());
 
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
 
startOfferExpiryWorker(io);
 
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`FixedNow matching API listening on port ${PORT}`);
});
 


