
Auth · JS
const express = require('express');
const pool = require('../db/pool');
const { hashPassword, verifyPassword, signToken } = require('../utils/auth');
const { JWT_SECRET } = require('../middleware/auth');
 
const MIN_PASSWORD_LENGTH = 8;
 
function authRouter() {
  const router = express.Router();
 
  // ---- Customers ----
 
  router.post('/customer/signup', async (req, res) => {
    const { email, password, fullName, phone } = req.body;
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'email, password, and fullName are required' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    try {
      const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      const passwordHash = hashPassword(password);
      const { rows } = await pool.query(
        `INSERT INTO customers (email, full_name, phone, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, full_name`,
        [email, fullName, phone || null, passwordHash]
      );
      const customer = rows[0];
      const token = signToken({ sub: customer.id, role: 'customer' }, JWT_SECRET);
      res.status(201).json({
        token,
        customer: { id: customer.id, email: customer.email, fullName: customer.full_name },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create account' });
    }
  });
 
  router.post('/customer/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT id, email, full_name, password_hash FROM customers WHERE email = $1',
        [email]
      );
      if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
        return res.status(401).json({ error: 'Incorrect email or password' });
      }
      const customer = rows[0];
      const token = signToken({ sub: customer.id, role: 'customer' }, JWT_SECRET);
      res.json({
        token,
        customer: { id: customer.id, email: customer.email, fullName: customer.full_name },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to log in' });
    }
  });
 
  // ---- Providers ----
 
  router.post('/provider/signup', async (req, res) => {
    const { email, password, fullName, businessName, phone } = req.body;
    if (!email || !password || !fullName || !phone) {
      return res.status(400).json({ error: 'email, password, fullName, and phone are required' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    try {
      const existing = await pool.query('SELECT id FROM providers WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      const passwordHash = hashPassword(password);
      const { rows } = await pool.query(
        `INSERT INTO providers (email, phone, full_name, business_name, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, full_name, business_name`,
        [email, phone, fullName, businessName || null, passwordHash]
      );
      const provider = rows[0];
      const token = signToken({ sub: provider.id, role: 'provider' }, JWT_SECRET);
      res.status(201).json({
        token,
        provider: {
          id: provider.id,
          email: provider.email,
          fullName: provider.full_name,
          businessName: provider.business_name,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create account' });
    }
  });
 
  router.post('/provider/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT id, email, full_name, business_name, password_hash FROM providers WHERE email = $1',
        [email]
      );
      if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
        return res.status(401).json({ error: 'Incorrect email or password' });
      }
      const provider = rows[0];
      const token = signToken({ sub: provider.id, role: 'provider' }, JWT_SECRET);
      res.json({
        token,
        provider: {
          id: provider.id,
          email: provider.email,
          fullName: provider.full_name,
          businessName: provider.business_name,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to log in' });
    }
  });
 
  return router;
}
 
module.exports = authRouter;
 


