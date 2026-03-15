const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getUserEqualizer, updateUserEqualizer } = require('../controllers/equalizerController');

router.get('/user/:userId', protect, getUserEqualizer);
router.put('/user/:userId', protect, updateUserEqualizer);

module.exports = router;
