
Websocket · JS
const { Server } = require('socket.io');
const pool = require('./db/pool');
const { verifyToken } = require('./utils/auth');
const { JWT_SECRET } = require('./middleware/auth');
 
// Only push a location update to the DB if the provider moved this far.
// Keeps write volume and battery drain down (per the brief's battery note).
const MIN_MOVEMENT_METERS = 10;
 
function setupWebSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' }, // tighten in production
  });
 
  io.on('connection', (socket) => {
    let identity = null; // { type: 'provider'|'customer', id } — set only after a verified 'identify'
 
    // Client identifies itself right after connecting. Requires a real
    // login token (the same one used for REST calls) — this used to trust
    // whatever {type, id} the client claimed, which meant anyone could
    // connect and impersonate any provider to intercept their job offers.
    socket.on('identify', ({ token }) => {
      try {
        const payload = verifyToken(token, JWT_SECRET);
        identity = { type: payload.role, id: payload.sub };
        socket.join(`${identity.type}:${identity.id}`);
        socket.emit('identify:ack', { type: identity.type, id: identity.id });
      } catch (err) {
        socket.emit('identify:error', { error: 'Invalid or expired token' });
      }
    });
 
    // Provider streams location while online. Throttled server-side by
    // distance moved, not just time, to save battery/bandwidth. Uses the
    // provider ID from the verified identity, not a client-supplied one.
    socket.on('provider:location', async ({ lng, lat }) => {
      if (!identity || identity.type !== 'provider') return;
      const providerId = identity.id;
      try {
        const { rows } = await pool.query(
          `SELECT ST_Distance(current_location, ST_MakePoint($1,$2)::geography) AS moved_m
           FROM providers WHERE id = $3`,
          [lng, lat, providerId]
        );
        const movedMeters = rows[0]?.moved_m;
        if (movedMeters !== null && movedMeters < MIN_MOVEMENT_METERS) return;
 
        await pool.query(
          `UPDATE providers
           SET current_location = ST_MakePoint($1,$2)::geography, last_location_at = now()
           WHERE id = $3`,
          [lng, lat, providerId]
        );
 
        // Broadcast to any customer currently tracking a job with this provider
        const { rows: activeJobs } = await pool.query(
          `SELECT id, customer_id FROM jobs
           WHERE accepted_provider_id = $1 AND status IN ('accepted','en_route','arrived','in_progress')`,
          [providerId]
        );
        for (const job of activeJobs) {
          io.to(`customer:${job.customer_id}`).emit('provider:location', {
            jobId: job.id,
            lng,
            lat,
          });
        }
      } catch (err) {
        console.error('Location update error:', err.message);
      }
    });
 
    // Provider flips the "Go Online" toggle — again, uses the verified
    // identity rather than a client-supplied providerId.
    socket.on('provider:setOnline', async ({ isOnline }) => {
      if (!identity || identity.type !== 'provider') return;
      await pool.query(`UPDATE providers SET is_online = $1 WHERE id = $2`, [isOnline, identity.id]);
      socket.emit('provider:onlineAck', { isOnline });
    });
 
    socket.on('disconnect', () => {
      // Optional: auto-set offline on disconnect for mobile providers.
      // Left out by default since a dropped connection isn't always intentional.
    });
  });
 
  return io;
}
 
module.exports = { setupWebSocket };
 


