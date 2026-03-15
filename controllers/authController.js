const User = require('../models/User');
const generateToken = require('../utils/generateToken');

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Please provide name, email and password.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
        return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    const user = await User.create({
        name,
        email,
        password,
        role: 'user', // Always 'user' — admin promotion via separate admin-only endpoint only
    });

    const token = generateToken(user._id);

    return res.status(201).json({
        success: true,
        message: 'User registered successfully.',
        data: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            token,
        },
    });
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Please provide email and password.' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.matchPassword(password))) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = generateToken(user._id);

    return res.status(200).json({
        success: true,
        message: 'Logged in successfully.',
        data: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            token,
        },
    });
};

/**
 * @desc    Get currently authenticated user
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = async (req, res) => {
    const user = await User.findById(req.user._id).populate('likedSongs');
    return res.status(200).json({
        success: true,
        data: user,
    });
};

module.exports = { register, login, getMe };
