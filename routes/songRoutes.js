const express = require('express');
const router = express.Router();
const {
    createSong,
    getAllSongs,
    getSongById,
    updateSong,
    deleteSong,
    bulkCreateSongs,
    bulkDeleteSongs,
} = require('../controllers/songController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/roleMiddleware');
const { uploadSongFiles, uploadBulkSongs } = require('../middleware/uploadMiddleware');

// Public routes
router.get('/', getAllSongs);
router.get('/:id', getSongById);

// Admin-only routes
router.post('/bulk', protect, adminOnly, uploadBulkSongs, bulkCreateSongs);  // ← before /:id
router.delete('/bulk', protect, adminOnly, bulkDeleteSongs);                    // ← before /:id
router.post('/', protect, adminOnly, uploadSongFiles, createSong);
router.put('/:id', protect, adminOnly, uploadSongFiles, updateSong);
router.delete('/:id', protect, adminOnly, deleteSong);

module.exports = router;
