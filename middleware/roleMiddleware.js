/**
 * Middleware: adminOnly
 * Restricts access to admin users only.
 * Must be used AFTER protect middleware.
 */
const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'Access denied. Admins only.',
    });
};

/**
 * Middleware: userOnly
 * Restricts access to regular users only.
 * Must be used AFTER protect middleware.
 */
const userOnly = (req, res, next) => {
    if (req.user && req.user.role === 'user') {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'Access denied. Regular users only.',
    });
};

module.exports = { adminOnly, userOnly };
