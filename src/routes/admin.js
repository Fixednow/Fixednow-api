const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/adminAuth');

function adminRouter() {
  const router = express.Router();
  router.use(requireAdmin);

  // The entire review queue — everything awaiting a human decision,
  // oldest first, with enough context (who, which category, what document)
  // to actually make that decision without opening the database directly.
  router.get('/documents', async (req, res) => {
    const status = req.query.status || 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT pd.id, pd.doc_type, pd.file_url, pd.status, pd.uploaded_at,
                p.id AS provider_id, p.full_name, p.email, p.phone,
                sc.name AS category_name
         FROM provider_documents pd
         JOIN provider_services ps ON ps.id = pd.provider_service_id
         JOIN providers p ON p.id = ps.provider_id
         JOIN service_categories sc ON sc.id = ps.category_id
         WHERE pd.status = $1
         ORDER BY pd.uploaded_at ASC`,
        [status]
      );
      res.json({ documents: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load documents' });
    }
  });

  // Approving is the one moment a category actually goes live for a
  // regulated trade — it flips provider_services.verification_status to
  // 'verified' in the same transaction as the document itself, so the two
  // can never drift out of sync.
  router.post('/documents/:id/approve', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const docRes = await client.query(
        `UPDATE provider_documents
         SET status = 'approved', reviewed_by = 'admin', reviewed_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING provider_service_id`,
        [req.params.id]
      );
      if (docRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Document not found, or already reviewed' });
      }
      await client.query(
        `UPDATE provider_services SET verification_status = 'verified' WHERE id = $1`,
        [docRes.rows[0].provider_service_id]
      );
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to approve document' });
    } finally {
      client.release();
    }
  });

  router.post('/documents/:id/reject', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const docRes = await client.query(
        `UPDATE provider_documents
         SET status = 'rejected', reviewed_by = 'admin', reviewed_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING provider_service_id`,
        [req.params.id]
      );
      if (docRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Document not found, or already reviewed' });
      }
      await client.query(
        `UPDATE provider_services SET verification_status = 'rejected' WHERE id = $1`,
        [docRes.rows[0].provider_service_id]
      );
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to reject document' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = adminRouter;
