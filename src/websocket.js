const { Server } = require('socket.io');
const pool = require('./db/pool');

// Only push a location update to the DB if the provider moved this far.
// Keeps write volume and battery drain down (per the brief's battery note).
const MIN_MOVEMENT_METERS = 10;

function setupWebSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' }, // tighten in production
  });

  io.on('connection', (socket) => {
    let identity = null; // { type: 'provider'|'customer', id }

    // Client identifies itself right after connecting
    socket.on('identify', ({ type, id }) => {
      identity = { type, id };
      socket.join(`${type}:${id}`);
    });

    // Provider streams location while online. Throttled server-side by
    // distance moved, not just time, to save battery/bandwidth.
    socket.on('provider:location', async ({ providerId, lng, lat }) => {
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

    // Provider flips the "Go Online" toggle
    socket.on('provider:setOnline', async ({ providerId, isOnline }) => {
      await pool.query(`UPDATE providers SET is_online = $1 WHERE id = $2`, [isOnline, providerId]);
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
