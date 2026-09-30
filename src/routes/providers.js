const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// The "weight" given to the platform-wide average in the Bayesian rating
// formula — effectively how many reviews of average quality a provider
// needs before their own rating starts to dominate. Higher = harder for a
// handful of 5-stars to rocket someone to the top; lower = new providers
// with few reviews rank closer to their raw average.
const MIN_VOTES_FOR_CONFIDENCE = 10;

function providersRouter() {
  const router = express.Router();

  // Browse list for the customer app's discovery screen, ranked by a
  // Bayesian-weighted rating rather than raw rating_avg — otherwise a
  // provider with one 5-star review outranks one with two hundred 4.8-star
  // reviews, which is the opposite of what "algorithmically surface the
  // best" should mean. Formula (IMDB-style):
  //
  //   weighted = (v / (v + m)) * R + (m / (v + m)) * C
  //
  // where R = provider's own average, v = their review count, C = the
  // platform-wide mean rating, m = MIN_VOTES_FOR_CONFIDENCE. A provider
  // with v >> m ranks close to their own average; v << m pulls them toward
  // the platform mean until they've earned enough reviews to trust.
  //
  // Optional ?categoryId= restricts to providers offering that category.
  // With no categoryId, defaults to providers in a portfolio-driven
  // category (Cake Maker, Florist, etc.) — the "quote switch" trades this
  // browse screen is for.
  //
  // Optional ?lng= & ?lat= restrict to providers whose OWN declared
  // service_radius_km for that category actually reaches the customer's
  // location — a florist who only serves 15km shouldn't show up for a
  // customer 40km away, however good their rating. Uses each provider's
  // base_location if set (fixed premises), falling back to current_location
  // (mobile providers who haven't set a fixed base). Distance filtering is
  // skipped entirely if lng/lat aren't provided, for backwards compatibility.
  router.get('/', async (req, res) => {
    const { categoryId, limit, lng, lat } = req.query;

    try {
      const params = [MIN_VOTES_FOR_CONFIDENCE];
      let categoryClause;
      if (categoryId) {
        params.push(categoryId);
        categoryClause = `sc.id = $${params.length}`;
      } else {
        categoryClause = `sc.portfolio_category = true`;
      }

      let locationClause = '';
      let locationSelect = '';
      const hasLocation = lng !== undefined && lat !== undefined;
      if (hasLocation) {
        params.push(Number(lng), Number(lat));
        const lngParamIdx = params.length - 1;
        const latParamIdx = params.length;
        locationClause = `
            AND ST_DWithin(
                  COALESCE(p.base_location, p.current_location),
                  ST_MakePoint($${lngParamIdx}, $${latParamIdx})::geography,
                  ps.service_radius_km * 1000
                )`;
        locationSelect = `,
            ST_Distance(
              COALESCE(p.base_location, p.current_location),
              ST_MakePoint($${lngParamIdx}, $${latParamIdx})::geography
            ) / 1000 AS distance_km`;
      }

      params.push(Number(limit) || 30);

      const { rows } = await pool.query(
        `
        WITH stats AS (
          SELECT COALESCE(
            SUM(rating_avg * rating_count) / NULLIF(SUM(rating_count), 0),
            4.5
          ) AS global_mean_rating
          FROM providers WHERE is_active = true
        ),
        ranked AS (
          SELECT DISTINCT ON (p.id)
            p.id,
            p.full_name,
            p.business_name,
            p.base_address_text,
            p.rating_avg,
            p.rating_count,
            sc.id AS category_id,
            sc.name AS category_name,
            (
              (p.rating_count::numeric / (p.rating_count + $1))
                * p.rating_avg
              + ($1::numeric / (p.rating_count + $1))
                * s.global_mean_rating
            ) AS weighted_score
            ${locationSelect}
          FROM providers p
          JOIN provider_services ps ON ps.provider_id = p.id AND ps.is_active = true
          JOIN service_categories sc ON sc.id = ps.category_id
          CROSS JOIN stats s
          WHERE p.is_active = true
            AND ps.verification_status IN ('not_required', 'verified')
            AND ${categoryClause}
            ${locationClause}
          ORDER BY p.id, weighted_score DESC
        )
        SELECT * FROM ranked
        ORDER BY weighted_score DESC
        LIMIT $${params.length}
        `,
        params
      );

      res.json({ providers: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load providers' });
    }
  });

  // Public profile: rating + a browsable portfolio of completed-job photos.
  // Only jobs where completion_photos_public = true are included — set
  // from the category default at job creation (on for the scheduled/quote
  // categories like Cake Maker, Florist; off for on-demand categories like
  // House Cleaner) and overridable per job by the customer.
  //
  // Optional ?categoryId= filters the portfolio to one service, useful when
  // a customer is comparing providers for a specific booking (e.g. only
  // this provider's cake photos, not their balloon work too).
  router.get('/:providerId/portfolio', async (req, res) => {
    const { providerId } = req.params;
    const { categoryId } = req.query;

    try {
      const providerRes = await pool.query(
        `SELECT id, full_name, business_name, base_address_text, rating_avg, rating_count
         FROM providers WHERE id = $1`,
        [providerId]
      );
      if (providerRes.rows.length === 0) {
        return res.status(404).json({ error: 'Provider not found' });
      }

      const params = [providerId];
      let categoryFilter = '';
      if (categoryId) {
        params.push(categoryId);
        categoryFilter = `AND j.category_id = $${params.length}`;
      }

      const portfolioRes = await pool.query(
        `SELECT
           j.id AS job_id,
           j.completion_photo_urls,
           j.completed_at,
           sc.name AS category_name,
           r.rating,
           r.comment
         FROM jobs j
         JOIN service_categories sc ON sc.id = j.category_id
         LEFT JOIN reviews r ON r.job_id = j.id
         WHERE j.accepted_provider_id = $1
           AND j.status = 'completed'
           AND j.completion_photos_public = true
           AND j.completion_photo_urls IS NOT NULL
           AND array_length(j.completion_photo_urls, 1) > 0
           ${categoryFilter}
         -- Best work first: highest-rated jobs surface to the top of the
         -- portfolio. Jobs with no review yet fall to the end rather than
         -- being treated as "unrated = neutral" and mixed into the middle.
         -- Most recent breaks ties within the same rating.
         ORDER BY r.rating DESC NULLS LAST, j.completed_at DESC
         LIMIT 50`,
        params
      );

      res.json({
        provider: providerRes.rows[0],
        portfolio: portfolioRes.rows,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load provider portfolio' });
    }
  });

  // ---- Authenticated: a provider managing their own service offerings ----
  // These are what actually let a newly signed-up provider do anything —
  // without a row in provider_services, a provider is invisible to both
  // the urgent-flow broadcast and the Book-ahead browse list, however
  // "online" they are.

  // List the categories this provider currently offers.
  router.get('/me/services', requireAuth('provider'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ps.id, ps.category_id, sc.name AS category_name,
                ps.service_radius_km, ps.flat_rate, ps.is_active,
                ps.verification_status
         FROM provider_services ps
         JOIN service_categories sc ON sc.id = ps.category_id
         WHERE ps.provider_id = $1 AND ps.is_active = true
         ORDER BY sc.name`,
        [req.user.id]
      );
      res.json({ services: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load your services' });
    }
  });

  // Add or update one category this provider offers. Upserts on
  // (provider_id, category_id) — calling this again for a category you
  // already offer just updates the radius/rate rather than erroring.
  router.post('/me/services', requireAuth('provider'), async (req, res) => {
    const { categoryId, serviceRadiusKm, flatRate } = req.body;
    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId is required' });
    }

    try {
      const categoryRes = await pool.query(
        `SELECT default_service_radius_km, requires_regulation FROM service_categories WHERE id = $1`,
        [categoryId]
      );
      if (categoryRes.rows.length === 0) {
        return res.status(404).json({ error: 'Unknown category' });
      }
      const { default_service_radius_km, requires_regulation } = categoryRes.rows[0];

      // Regulated trades (Plumber, Electrician) start out needing document
      // verification rather than going straight to bookable — everyone
      // else can start receiving jobs immediately.
      const verificationStatus = requires_regulation ? 'pending' : 'not_required';

      const { rows } = await pool.query(
        `INSERT INTO provider_services (provider_id, category_id, service_radius_km, flat_rate, verification_status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider_id, category_id) DO UPDATE
           SET service_radius_km = EXCLUDED.service_radius_km,
               flat_rate = EXCLUDED.flat_rate,
               is_active = true
         RETURNING id, category_id, service_radius_km, flat_rate, is_active, verification_status`,
        [req.user.id, categoryId, serviceRadiusKm || default_service_radius_km, flatRate || null, verificationStatus]
      );
      res.status(201).json({ service: rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to add service' });
    }
  });

  // Stop offering a category. Soft-deletes (is_active = false) rather than
  // deleting the row outright, so past jobs/reviews under that category
  // keep a valid reference to it.
  router.delete('/me/services/:categoryId', requireAuth('provider'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE provider_services SET is_active = false
         WHERE provider_id = $1 AND category_id = $2
         RETURNING id`,
        [req.user.id, req.params.categoryId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "You don't offer this category" });
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to remove service' });
    }
  });

  // Submit a verification document for one of your categories. This
  // records that a document was submitted and where it lives — it does
  // NOT accept or store a file upload itself. fileUrl must point somewhere
  // the file is already hosted. Until real file storage exists in this
  // app, treat this as the review-workflow skeleton, not a finished
  // end-to-end upload — see the README.
  router.post('/me/services/:categoryId/documents', requireAuth('provider'), async (req, res) => {
    const { categoryId } = req.params;
    const { docType, fileUrl } = req.body;
    if (!docType || !fileUrl) {
      return res.status(400).json({ error: 'docType and fileUrl are required' });
    }

    try {
      const serviceRes = await pool.query(
        `SELECT id FROM provider_services WHERE provider_id = $1 AND category_id = $2 AND is_active = true`,
        [req.user.id, categoryId]
      );
      if (serviceRes.rows.length === 0) {
        return res.status(404).json({ error: "You don't offer this category" });
      }
      const providerServiceId = serviceRes.rows[0].id;

      const { rows } = await pool.query(
        `INSERT INTO provider_documents (provider_service_id, doc_type, file_url)
         VALUES ($1, $2, $3)
         RETURNING id, doc_type, file_url, status, uploaded_at`,
        [providerServiceId, docType, fileUrl]
      );

      // Resubmitting after a rejection puts the category back under review
      // rather than leaving it stuck as 'rejected' forever.
      await pool.query(
        `UPDATE provider_services SET verification_status = 'pending'
         WHERE id = $1 AND verification_status = 'rejected'`,
        [providerServiceId]
      );

      res.status(201).json({ document: rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to submit document' });
    }
  });

  // Your own submitted documents for one category, with review status —
  // so the provider app can show "1 document pending review" rather than
  // leaving a provider guessing why they're not getting jobs yet.
  router.get('/me/services/:categoryId/documents', requireAuth('provider'), async (req, res) => {
    const { categoryId } = req.params;
    try {
      const { rows } = await pool.query(
        `SELECT pd.id, pd.doc_type, pd.file_url, pd.status, pd.uploaded_at, pd.reviewed_at
         FROM provider_documents pd
         JOIN provider_services ps ON ps.id = pd.provider_service_id
         WHERE ps.provider_id = $1 AND ps.category_id = $2
         ORDER BY pd.uploaded_at DESC`,
        [req.user.id, categoryId]
      );
      res.json({ documents: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load documents' });
    }
  });

  return router;
}

module.exports = providersRouter;
