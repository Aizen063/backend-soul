const express = require('express');
const router = express.Router();
const {
    createArtist,
    getAllArtists,
    getArtistById,
    getSongsByArtist,
    updateArtist,
    deleteArtist,
} = require('../controllers/artistController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/roleMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

// Public routes
router.get('/', getAllArtists);
router.get('/:id', getArtistById);
router.get('/:id/songs', getSongsByArtist);

// Admin-only routes
router.post('/', protect, adminOnly, upload.single('photo'), createArtist);
router.put('/:id', protect, adminOnly, upload.single('photo'), updateArtist);
router.delete('/:id', protect, adminOnly, deleteArtist);

module.exports = router;
