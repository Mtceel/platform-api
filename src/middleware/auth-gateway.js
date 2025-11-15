// API Gateway compatible auth middleware
const authMiddleware = async (req, res, next) => {
  // Check voor API Gateway calls (internal network)
  const apiGatewayTenantId = req.headers['x-tenant-id'];
  if (apiGatewayTenantId) {
    // Request from API Gateway - trust the tenant_id header
    req.userId = 0; // API Gateway service account
    req.tenantId = parseInt(apiGatewayTenantId);
    req.userRole = 'api_integration';
    
    console.log('[Auth] API Gateway request - tenant_id:', req.tenantId);
    
    // Audit log voor API calls
    try {
      await db.query(
        'INSERT INTO audit_logs (user_id, tenant_id, action, endpoint, ip_address) VALUES ($1, $2, $3, $4, $5)',
        [0, req.tenantId, `API_${req.method}`, req.path, req.ip]
      );
    } catch (err) {
      console.error('[Auth] Audit log error:', err.message);
    }
    
    return next();
  }
  
  // Normal JWT authentication voor dashboard/frontend
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.tenantId = decoded.tenantId;
    req.userRole = decoded.role || 'merchant';
    
    // Audit log
    await db.query(
      'INSERT INTO audit_logs (user_id, tenant_id, action, endpoint, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [req.userId, req.tenantId, req.method, req.path, req.ip]
    );
    
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authMiddleware;
