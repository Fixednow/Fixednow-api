const pool = require('../db/pool');

// Fallback if a category somehow has no configured timeout.
const DEFAULT_OFFER_TIMEOUT_SECONDS = 20;

// Extra time given per reference photo the customer attached (tyre
// sidewall, appliance model plate, damaged part) — each photo is
// something the provider may need to individually check against
// stock/compatibility before committing, not just glance at.
const PHOTO_CHECK_BONUS_SECONDS_PER_PHOTO = 30;

// Hard ceiling so a job can never sit "broadcasting" indefinitely, however
// many photos stack up. 120s = category base + up to ~3 photos on the
// longest-base categories, which covers the realistic case without letting
// someone attach 20 photos and stall the customer for minutes.
const MAX_OFFER_TIMEOUT_SECONDS = 120;

// How many providers get pinged simultaneously per round. First to accept
// wins; the rest are cancelled. Bigger = faster fill, but more providers
// get a "someone else got it" notification each round.
const PARALLEL_PING_COUNT = 3;

/**
 * Work out how long this specific job's offers should stay open: the
 * category's configured base window, plus 30s per attached photo, capped
 * at a sane max.
 */
function resolveOfferTimeout({ categoryTimeoutSeconds, photoCount = 0 }) {
  const base = categoryTimeoutSeconds || DEFAULT_OFFER_TIMEOUT_SECONDS;
  const withBonus = base + photoCount * PHOTO_CHECK_BONUS_SECONDS_PER_PHOTO;
  return Math.min(withBonus, MAX_OFFER_TIMEOUT_SECONDS);
}

// Pool size to fetch from PostGIS per round (must be >= PARALLEL_PING_COUNT
// so we always have candidates in reserve if a round exhausts).
const CANDIDATE_POOL_SIZE = 8;

/**
 * Find online providers who offer `categoryId`, ordered by distance,
 * within each provider's own service radius.
 */
async function findNearbyProviders(categoryId, lng, lat, limit = CANDIDATE_POOL_SIZE) {
  const { rows } = await pool.query(
    `
    SELECT
      p.id AS provider_id,
      p.full_name,
      ps.id AS provider_service_id,
      ST_Distance(p.current_location, ST_MakePoint($1, $2)::geography) / 1000 AS distance_km
    FROM providers p
    JOIN provider_services ps ON ps.provider_id = p.id
    WHERE p.is_online = true
      AND p.is_active = true
      AND ps.category_id = $3
      AND ps.is_active = true
      AND ps.verification_status IN ('not_required', 'verified')
      AND ST_DWithin(
            p.current_location,
            ST_MakePoint($1, $2)::geography,
            ps.service_radius_km * 1000
          )
    ORDER BY distance_km ASC
    LIMIT $4
    `,
    [lng, lat, categoryId, limit]
  );
  return rows;
}

/**
 * Kick off (or continue) broadcasting a job: find up to PARALLEL_PING_COUNT
 * fresh candidates and ping them all at once ("round"). First to accept
 * wins; siblings get cancelled. Returns the offers created, or [] if no
 * candidates remain.
 */
async function broadcastJob(jobId, io) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jobRes = await client.query(
      `SELECT j.id, j.category_id, j.status, j.photo_urls,
              ST_X(j.service_location::geometry) AS lng,
              ST_Y(j.service_location::geometry) AS lat,
              sc.offer_timeout_seconds AS category_timeout_seconds
       FROM jobs j
       JOIN service_categories sc ON sc.id = j.category_id
       WHERE j.id = $1 FOR UPDATE`,
      [jobId]
    );
    if (jobRes.rows.length === 0) throw new Error('Job not found');
    const job = jobRes.rows[0];

    const timeoutSeconds = resolveOfferTimeout({
      categoryTimeoutSeconds: job.category_timeout_seconds,
      hasPhotos: Array.isArray(job.photo_urls) && job.photo_urls.length > 0,
    });

    // Don't start a new round if the job is already locked in or over.
    if (['accepted', 'en_route', 'arrived', 'in_progress', 'completed', 'cancelled'].includes(job.status)) {
      await client.query('COMMIT');
      return [];
    }

    // Providers already offered this job (any status, any prior round) get
    // excluded so we never re-ping someone who already declined/expired.
    const alreadyOffered = await client.query(
      `SELECT provider_id FROM job_offers WHERE job_id = $1`,
      [jobId]
    );
    const excludeIds = new Set(alreadyOffered.rows.map((r) => r.provider_id));

    const candidates = (await findNearbyProviders(job.category_id, job.lng, job.lat))
      .filter((c) => !excludeIds.has(c.provider_id))
      .slice(0, PARALLEL_PING_COUNT);

    if (candidates.length === 0) {
      await client.query(
        `UPDATE jobs SET status = 'no_providers' WHERE id = $1`,
        [jobId]
      );
      await client.query('COMMIT');
      return [];
    }

    const existingRankRes = await client.query(
      `SELECT COALESCE(MAX(broadcast_rank), 0) AS max_rank FROM job_offers WHERE job_id = $1`,
      [jobId]
    );
    let rank = existingRankRes.rows[0].max_rank;

    const offers = [];
    for (const candidate of candidates) {
      rank += 1;
     const offerRes = await client.query(
     `INSERT INTO job_offers
        (job_id, provider_id, distance_km, broadcast_rank, timeout_seconds, status, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', now() + make_interval(secs => $6))
      RETURNING *`,
     [jobId, candidate.provider_id, candidate.distance_km, rank, timeoutSeconds, timeoutSeconds]
   );
      );
      offers.push(offerRes.rows[0]);
    }

    await client.query(
      `UPDATE jobs SET status = 'broadcasting' WHERE id = $1 AND status != 'broadcasting'`,
      [jobId]
    );

    await client.query('COMMIT');

    // Ping everyone in this round simultaneously.
    if (io) {
      offers.forEach((offer) => {
        io.to(`provider:${offer.provider_id}`).emit('job:offer', {
          offerId: offer.id,
          jobId,
          distanceKm: Number(offer.distance_km).toFixed(1),
          expiresAt: offer.expires_at,
          timeoutSeconds: offer.timeout_seconds,
          hasPhotos: Array.isArray(job.photo_urls) && job.photo_urls.length > 0,
        });
      });
    }

    return offers;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * If no pending offers remain for a job and it's still unaccepted, start
 * the next round. Called after a decline or a batch of expiries.
 */
async function maybeAdvanceRound(jobId, io) {
  const { rows } = await pool.query(
    `SELECT status FROM jobs WHERE id = $1`,
    [jobId]
  );
  const job = rows[0];
  if (!job || job.status !== 'broadcasting') return [];

  const { rows: pending } = await pool.query(
    `SELECT 1 FROM job_offers WHERE job_id = $1 AND status = 'pending' LIMIT 1`,
    [jobId]
  );
  if (pending.length > 0) return []; // still waiting on others in this round

  return broadcastJob(jobId, io);
}

/**
 * Provider accepts an offer: lock in the job, cancel every other pending
 * offer for this job (this round's siblings), notify the customer and the
 * losing providers.
 */
async function acceptOffer(offerId, providerId, io) {
  const client = await pool.connect();
  let cancelledProviderIds = [];
  let jobId;
  try {
    await client.query('BEGIN');

    const offerRes = await client.query(
      `SELECT * FROM job_offers WHERE id = $1 AND provider_id = $2 FOR UPDATE`,
      [offerId, providerId]
    );
    if (offerRes.rows.length === 0) throw new Error('Offer not found');
    const offer = offerRes.rows[0];
    jobId = offer.job_id;

    if (offer.status !== 'pending') {
      throw new Error(`Offer already ${offer.status}`);
    }
    if (new Date(offer.expires_at) < new Date()) {
      await client.query(`UPDATE job_offers SET status = 'expired' WHERE id = $1`, [offerId]);
      await client.query('COMMIT');
      throw new Error('Offer expired');
    }

    await client.query(
      `UPDATE job_offers SET status = 'accepted', responded_at = now() WHERE id = $1`,
      [offerId]
    );

    const cancelledRes = await client.query(
      `UPDATE job_offers SET status = 'expired'
       WHERE job_id = $1 AND id != $2 AND status = 'pending'
       RETURNING provider_id`,
      [offer.job_id, offerId]
    );
    cancelledProviderIds = cancelledRes.rows.map((r) => r.provider_id);

    await client.query(
      `UPDATE jobs SET status = 'accepted', accepted_provider_id = $1, accepted_at = now()
       WHERE id = $2`,
      [providerId, offer.job_id]
    );

    await client.query('COMMIT');

    if (io) {
      const jobRes = await pool.query(`SELECT customer_id FROM jobs WHERE id = $1`, [offer.job_id]);
      const customerId = jobRes.rows[0]?.customer_id;
      if (customerId) {
        io.to(`customer:${customerId}`).emit('job:accepted', {
          jobId: offer.job_id,
          providerId,
        });
      }
      // Let the other providers in this round know the job's gone so their
      // UI can clear the offer instead of waiting out the countdown.
      cancelledProviderIds.forEach((pid) => {
        io.to(`provider:${pid}`).emit('job:offerCancelled', {
          jobId: offer.job_id,
          reason: 'accepted_by_other_provider',
        });
      });
    }

    return offer;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Provider explicitly declines. Only advances to the next round once every
 * offer in the current round has been resolved (declined/expired) — an
 * early decline doesn't cut short someone else's countdown.
 */
async function declineOffer(offerId, providerId, io) {
  const { rows } = await pool.query(
    `UPDATE job_offers SET status = 'declined', responded_at = now()
     WHERE id = $1 AND provider_id = $2 AND status = 'pending'
     RETURNING job_id`,
    [offerId, providerId]
  );
  if (rows.length === 0) throw new Error('Offer not found or already resolved');
  return maybeAdvanceRound(rows[0].job_id, io);
}

module.exports = {
  DEFAULT_OFFER_TIMEOUT_SECONDS,
  PHOTO_CHECK_BONUS_SECONDS_PER_PHOTO,
  MAX_OFFER_TIMEOUT_SECONDS,
  PARALLEL_PING_COUNT,
  resolveOfferTimeout,
  findNearbyProviders,
  broadcastJob,
  maybeAdvanceRound,
  acceptOffer,
  declineOffer,
};
