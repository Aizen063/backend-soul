const User = require('../models/User');

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const ensureCanAccessUser = (req, userId) => {
    const requesterId = req.user?._id?.toString();
    return requesterId === userId || req.user?.role === 'admin';
};

/**
 * @desc    Get user equalizer settings
 * @route   GET /api/Equilizer/user/:userId
 * @access  Private (owner or admin)
 */
const getUserEqualizer = async (req, res) => {
    const { userId } = req.params;

    if (!ensureCanAccessUser(req, userId)) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const user = await User.findById(userId).select('equalizerSettings');
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.status(200).json({
        success: true,
        ...user.equalizerSettings,
    });
};

/**
 * @desc    Update user equalizer settings
 * @route   PUT /api/Equilizer/user/:userId
 * @access  Private (owner or admin)
 */
const updateUserEqualizer = async (req, res) => {
    const { userId } = req.params;

    if (!ensureCanAccessUser(req, userId)) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const { bandsJson, preset, bass, mid, treble } = req.body;

    let safeBandsJson = user.equalizerSettings?.bandsJson;
    if (typeof bandsJson === 'string') {
        try {
            const parsed = JSON.parse(bandsJson);
            if (Array.isArray(parsed) && parsed.length === 10 && parsed.every((n) => typeof n === 'number')) {
                safeBandsJson = JSON.stringify(parsed.map((n) => clamp(n, -12, 12)));
            }
        } catch {
            return res.status(400).json({ success: false, message: 'bandsJson must be valid JSON.' });
        }
    }

    user.equalizerSettings = {
        bandsJson: safeBandsJson,
        preset: typeof preset === 'string' && preset.trim() ? preset.trim() : (user.equalizerSettings?.preset || 'Flat'),
        bass: Number.isFinite(Number(bass)) ? clamp(Number(bass), -12, 12) : (user.equalizerSettings?.bass || 0),
        mid: Number.isFinite(Number(mid)) ? clamp(Number(mid), -12, 12) : (user.equalizerSettings?.mid || 0),
        treble: Number.isFinite(Number(treble)) ? clamp(Number(treble), -12, 12) : (user.equalizerSettings?.treble || 0),
        updatedAt: new Date(),
    };

    await user.save();

    return res.status(200).json({
        success: true,
        message: 'Equalizer settings saved.',
        ...user.equalizerSettings,
    });
};

module.exports = {
    getUserEqualizer,
    updateUserEqualizer,
};
