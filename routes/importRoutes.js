const express = require('express');
const router = express.Router();
const { startImport, getImportStatus, listImports, listDownloads, uploadDownloads, clearDownloads } = require('../controllers/importController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/roleMiddleware');

router.post('/', protect, adminOnly, startImport);
router.get('/', protect, adminOnly, listImports);
router.get('/downloads', protect, adminOnly, listDownloads);       // ← before /:jobId
router.delete('/downloads', protect, adminOnly, clearDownloads);    // ← New route
router.post('/upload-downloads', protect, adminOnly, uploadDownloads);     // ← before /:jobId
router.get('/:jobId', protect, adminOnly, getImportStatus);

module.exports = router;
