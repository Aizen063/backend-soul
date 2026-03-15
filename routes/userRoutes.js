const express = require('express');
const router = express.Router();
const {
    getAllUsers,
    deleteUser,
    updateProfile,
    toggleLikeSong,
    getLikedSongs,
    getHistory,
    addToHistory,
    changePassword,
    getAdminStats,
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/roleMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

// Admin-only routes
router.get('/', protect, adminOnly, getAllUsers);
router.get('/admin/stats', protect, adminOnly, getAdminStats);
router.delete('/:id', protect, adminOnly, deleteUser);

// Auth user routes
router.put('/profile', protect, upload.single('profilePic'), updateProfile);
router.put('/change-password', protect, changePassword);
router.put('/like/:songId', protect, toggleLikeSong);
router.get('/liked', protect, getLikedSongs);
router.get('/history', protect, getHistory);
router.post('/history', protect, addToHistory);

module.exports = router;
