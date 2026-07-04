const express = require('express');
const pool = require('../db/pool');

function customersRouter() {
  const router = express.Router();

  // Minimal customer creation. There's no auth system yet (see README known
  // gaps) — this exists so client apps have a real customer_id to attach to
  // jobs/reviews without building full signup/login first. Idempotent on
  // email so reloading the app doesn't spam new rows.
  router.post('/', async (req, res) => {
    const { email, fullName, phone } = req.body;
    if (!email || !fullName) {
      return res.status(400).json({ error: 'email and fullName are required' });
    }

    try {
      const existing = await pool.query(`SELECT id FROM customers WHERE email = $1`, [email]);
      if (existing.rows.length > 0) {
        return res.json({ customerId: existing.rows[0].id });
      }

      const { rows } = await pool.query(
        `INSERT INTO customers (email, full_name, phone, password_hash)
         VALUES ($1, $2, $3, 'demo')
         RETURNING id`,
        [email, fullName, phone || null]
      );
      res.status(201).json({ customerId: rows[0].id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create customer' });
    }
  });

  return router;
}

module.exports = customersRouter;
