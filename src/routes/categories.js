const express = require('express');
const pool = require('../db/pool');

function categoriesRouter() {
  const router = express.Router();

  // Public: list active service categories. Client apps need this to
  // resolve a category name to its UUID before calling POST /jobs, and to
  // know each category's flow_type / offer_timeout_seconds / etc. without
  // hardcoding them twice.
  router.get('/', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, slug, flow_type, base_type, requires_regulation,
                offer_timeout_seconds, requires_completion_photo, portfolio_category
         FROM service_categories
         WHERE is_active = true
         ORDER BY name`
      );
      res.json({ categories: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load categories' });
    }
  });

  return router;
}

module.exports = categoriesRouter;
