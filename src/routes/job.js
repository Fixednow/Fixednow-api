const express = require('express');
const pool = require('../db/pool');
const { broadcastJob, acceptOffer, declineOffer } = require('../services/matchingService');

function jobsRouter(io) {
  const router = express.Router();

  // Customer submits a new job request (on-demand or scheduled).
  // photoUrls: reference images (tyre sidewall, appliance model plate,
  // damaged part) — presence of these extends the provider's response
  // window since they may need to check stock/compatibility first.
  // photosPublic: optional override for whether this job's completion
  // photos should appear on the provider's public portfolio. Defaults to
  // the category's `portfolio_category` setting if not specified.
  router.post('/', async (req, res) => {
    const { customerId, categoryId, lng, lat, addressText, description,
            urgencyLevel, scheduledFor, photoUrls, photosPublic } = req.body;

    if (!customerId || !categoryId || lng === undefined || lat === undefined) {
      return res.status(400).json({ error: 'customerId, categoryId, lng, lat are required' });
    }

    try {
      const categoryRes = await pool.query(
        `SELECT flow_type, offer_timeout_seconds, portfolio_category FROM service_categories WHERE id = $1`,
        [categoryId]
      );
      if (categoryRes.rows.length === 0) {
        return res.status(404).json({ error: 'Unknown category' });
      }
      const { flow_type, portfolio_category } = categoryRes.rows[0];
      const completionPhotosPublic = typeof photosPublic === 'boolean' ? photosPublic : portfolio_category;

      const jobRes = await pool.query(
        `INSERT INTO jobs
           (customer_id, category_id, flow_type, service_location, address_text,
            description, urgency_level, scheduled_for, photo_urls, completion_photos_public)
         VALUES ($1, $2, $3, ST_MakePoint($4,$5)::geography, $6, $7, $8, $9, $10, $11)
         RETURNING id, status, flow_type, photo_urls, completion_photos_public`,
        [customerId, categoryId, flow_type, lng, lat, addressText, description,
         urgencyLevel || 'standard', scheduledFor || null, photoUrls || null, completionPhotosPublic]
      );
      const job = jobRes.rows[0];

      // On-demand jobs broadcast immediately. Scheduled jobs could be queued
      // for a later broadcast window — kept simple here and broadcast now too.
      const offers = await broadcastJob(job.id, io);

      res.status(201).json({
        job,
        pingedProviders: offers.map((o) => ({
          offerId: o.id,
          providerId: o.provider_id,
          providerDistanceKm: o.distance_km,
          timeoutSeconds: o.timeout_seconds,
        })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create job' });
    }
  });

  // Provider accepts a specific offer
  router.post('/:jobId/offers/:offerId/accept', async (req, res) => {
    const { offerId } = req.params;
    const { providerId } = req.body;
    if (!providerId) return res.status(400).json({ error: 'providerId is required' });

    try {
      const offer = await acceptOffer(offerId, providerId, io);
      res.json({ offer });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  // Provider declines — cascades to next-closest automatically
  router.post('/:jobId/offers/:offerId/decline', async (req, res) => {
    const { offerId } = req.params;
    const { providerId } = req.body;
    if (!providerId) return res.status(400).json({ error: 'providerId is required' });

    try {
      // Empty array means the rest of this round is still pending —
      // the next round only fires once every sibling offer has resolved.
      const nextRoundOffers = await declineOffer(offerId, providerId, io);
      res.json({ nextRoundOffers });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  // Provider advances the job through non-terminal stages (en_route,
  // arrived, in_progress). Completion is handled separately below since
  // it may require proof-of-work photos.
  const ADVANCEABLE_STATUSES = ['en_route', 'arrived', 'in_progress'];
  router.post('/:jobId/status', async (req, res) => {
    const { jobId } = req.params;
    const { providerId, status } = req.body;
    if (!providerId || !status) {
      return res.status(400).json({ error: 'providerId and status are required' });
    }
    if (!ADVANCEABLE_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ADVANCEABLE_STATUSES.join(', ')}` });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jobs SET status = $1
         WHERE id = $2 AND accepted_provider_id = $3
         RETURNING id, status, customer_id`,
        [status, jobId, providerId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Job not found or not assigned to this provider' });
      }
      const job = rows[0];

      if (io) {
        io.to(`customer:${job.customer_id}`).emit('job:statusUpdate', { jobId, status });
      }
      res.json({ job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update job status' });
    }
  });

  // Provider marks the job complete. If the category requires proof of
  // work, at least one completion photo is mandatory — this is enforced
  // server-side, not just in the app UI, since that's the only place it
  // actually protects the customer/provider in a dispute.
  router.post('/:jobId/complete', async (req, res) => {
    const { jobId } = req.params;
    const { providerId, photoUrls } = req.body;
    if (!providerId) return res.status(400).json({ error: 'providerId is required' });

    try {
      const jobRes = await pool.query(
        `SELECT j.id, j.customer_id, j.accepted_provider_id, sc.requires_completion_photo
         FROM jobs j
         JOIN service_categories sc ON sc.id = j.category_id
         WHERE j.id = $1`,
        [jobId]
      );
      if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = jobRes.rows[0];

      if (job.accepted_provider_id !== providerId) {
        return res.status(403).json({ error: 'Job is not assigned to this provider' });
      }
      if (job.requires_completion_photo && (!Array.isArray(photoUrls) || photoUrls.length === 0)) {
        return res.status(400).json({
          error: 'This job requires at least one photo of the completed work before it can be marked complete',
        });
      }

      const { rows } = await pool.query(
        `UPDATE jobs
         SET status = 'completed', completed_at = now(), completion_photo_urls = $1
         WHERE id = $2
         RETURNING *`,
        [photoUrls || null, jobId]
      );
      const updatedJob = rows[0];

      if (io) {
        io.to(`customer:${job.customer_id}`).emit('job:completed', {
          jobId,
          completionPhotoUrls: updatedJob.completion_photo_urls,
        });
      }

      res.json({ job: updatedJob });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to complete job' });
    }
  });

  // Customer rates a completed job. This is the only writer of
  // providers.rating_avg/rating_count — rolled into the running average
  // rather than recomputed from scratch each time.
  router.post('/:jobId/review', async (req, res) => {
    const { jobId } = req.params;
    const { customerId, rating, comment } = req.body;
    if (!customerId || rating === undefined) {
      return res.status(400).json({ error: 'customerId and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const jobRes = await client.query(
        `SELECT id, customer_id, accepted_provider_id, status FROM jobs WHERE id = $1 FOR UPDATE`,
        [jobId]
      );
      if (jobRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Job not found' });
      }
      const job = jobRes.rows[0];

      if (job.customer_id !== customerId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This job does not belong to this customer' });
      }
      if (job.status !== 'completed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Job must be completed before it can be reviewed' });
      }

      const reviewRes = await client.query(
        `INSERT INTO reviews (job_id, customer_id, provider_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (job_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment
         RETURNING *`,
        [jobId, customerId, job.accepted_provider_id, rating, comment || null]
      );

      await client.query(
        `UPDATE providers
         SET rating_count = rating_count + 1,
             rating_avg = ROUND(((rating_avg * rating_count) + $1) / (rating_count + 1), 2)
         WHERE id = $2`,
        [rating, job.accepted_provider_id]
      );

      await client.query('COMMIT');
      res.status(201).json({ review: reviewRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to submit review' });
    } finally {
      client.release();
    }
  });

  // Poll job status (customer-side fallback if not using sockets)
  router.get('/:jobId', async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [req.params.jobId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json(rows[0]);
  });

  return router;
}

module.exports = jobsRouter;
