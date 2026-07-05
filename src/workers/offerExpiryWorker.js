const pool = require('../db/pool');
const { maybeAdvanceRound } = require('../services/matchingService');

const POLL_INTERVAL_MS = 3000;

/**
 * Polls for pending offers whose countdown ran out with no response, marks
 * them expired, and — once every offer in a job's current round has been
 * resolved — starts the next round. In production this is better handled
 * with a proper job queue (BullMQ) or Postgres LISTEN/NOTIFY, but polling
 * is simple and fine at MVP scale.
 */
function startOfferExpiryWorker(io) {
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `UPDATE job_offers
         SET status = 'expired'
         WHERE status = 'pending' AND expires_at < now()
         RETURNING job_id`
      );

      // Multiple offers can expire together (a whole round timing out at
      // once) — dedupe so we only evaluate each job once.
      const jobIds = [...new Set(rows.map((r) => r.job_id))];

      for (const jobId of jobIds) {
        try {
          await maybeAdvanceRound(jobId, io);
        } catch (err) {
          console.error(`Failed to advance round for job ${jobId}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Offer expiry worker error:', err.message);
    }
  }, POLL_INTERVAL_MS);

  console.log(`Offer expiry worker started (polling every ${POLL_INTERVAL_MS}ms)`);
}

module.exports = { startOfferExpiryWorker };
