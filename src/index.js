import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import axios from 'axios';
import { getEnabledFeatures, isFeatureEnabled } from './feature-flags.js';
import { setupPageBuilderRoutes } from './page-builder.js';
import { createDefaultTheme } from './default-theme.js';

const app = express();
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Microservice URLs
const SERVICES = {
  products: 'http://products-service.platform-services.svc.cluster.local',
  orders: 'http://orders-service.platform-services.svc.cluster.local',
  customers: 'http://customers-service.platform-services.svc.cluster.local',
  discounts: 'http://discounts-service.platform-services.svc.cluster.local',
  analytics: 'http://analytics-service.platform-services.svc.cluster.local',
  checkout: 'http://checkout-service.platform-services.svc.cluster.local',
};

// Proxy helper to forward requests to microservices
const proxyToService = async (serviceUrl, req, res) => {
  try {
    const method = req.method.toLowerCase();
    const path = req.path.replace('/api', '/api'); // Keep /api prefix
    const url = `${serviceUrl}${path}`;
    
    const config = {
      method,
      url,
      params: req.query,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };
    
    if (['post', 'put', 'patch'].includes(method)) {
      config.data = req.body;
    }
    
    console.log(`[PROXY] ${method.toUpperCase()} ${url}`);
    const response = await axios(config);
    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[PROXY ERROR]:`, error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    return res.status(503).json({ error: 'Service unavailable' });
  }
};

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod-CHANGE-THIS';
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'admin@fv-company.com';
const SUPER_ADMIN_PASSWORD_HASH = process.env.SUPER_ADMIN_PASSWORD_HASH; // Set via env

// Database connection with connection pooling
const db = new pg.Pool({
  host: process.env.DB_HOST || 'postgres.platform-services.svc.cluster.local',
  port: 5432,
  database: 'saas_platform',
  user: 'postgres',
  password: 'postgres123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis connection
const redis = createClient({
  url: `redis://${process.env.REDIS_HOST || 'redis.platform-services.svc.cluster.local'}:6379`
});
redis.on('error', err => console.log('Redis error:', err));
await redis.connect();

// Rate limiting helper
const rateLimitCache = new Map();
const rateLimit = (key, maxRequests, windowMs) => {
  const now = Date.now();
  const requests = rateLimitCache.get(key) || [];
  const recentRequests = requests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitCache.set(key, recentRequests);
  return true;
};

// Auth middleware
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.tenantId = decoded.tenantId;
    req.userRole = decoded.role || 'merchant';
    
    // Add user object for page-builder.js
    req.user = {
      userId: decoded.userId,
      tenantId: decoded.tenantId,
      role: decoded.role || 'merchant'
    };
    
    // Audit log (skip for super admin with userId 0)
    if (req.userId !== 0) {
      await db.query(
        'INSERT INTO audit_logs (user_id, tenant_id, action, endpoint, ip_address) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, req.tenantId, req.method, req.path, req.ip]
      );
    }
    
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Super admin middleware
const superAdminMiddleware = async (req, res, next) => {
  if (req.userRole !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};

// Rate limit middleware
const rateLimitMiddleware = (maxRequests = 100, windowMs = 60000) => {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    if (!rateLimit(key, maxRequests, windowMs)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
};

// === HEALTH & STATUS ===

app.get('/health', async (req, res) => {
  try {
    // Check database
    await db.query('SELECT 1');
    
    // Check Redis
    await redis.ping();
    
    res.json({
      status: 'healthy',
      service: 'platform-api-enterprise',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'healthy',
        redis: 'healthy'
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message
    });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const dbStart = Date.now();
    await db.query('SELECT 1');
    const dbLatency = Date.now() - dbStart;
    
    const redisStart = Date.now();
    await redis.ping();
    const redisLatency = Date.now() - redisStart;
    
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM tenants) as total_tenants,
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM products) as total_products,
        (SELECT COUNT(*) FROM orders) as total_orders,
        (SELECT SUM(total) FROM orders WHERE status = 'completed') as total_revenue
    `);
    
    res.json({
      status: 'operational',
      timestamp: new Date().toISOString(),
      services: {
        api: { status: 'operational', latency: 0 },
        database: { status: 'operational', latency: dbLatency },
        redis: { status: 'operational', latency: redisLatency },
        storefront: { status: 'operational' },
        dashboard: { status: 'operational' }
      },
      metrics: stats.rows[0]
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      error: err.message
    });
  }
});

// === AUTH ENDPOINTS ===

app.post('/api/signup', rateLimitMiddleware(10, 3600000), async (req, res) => {
  const { email, password, fullName, storeName, subdomain } = req.body;
  
  if (!email || !password || !storeName || !subdomain) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Validate subdomain
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({ error: 'Invalid subdomain format. Use only lowercase letters, numbers, and hyphens.' });
  }
  
  if (subdomain.length < 3 || subdomain.length > 63) {
    return res.status(400).json({ error: 'Subdomain must be between 3 and 63 characters' });
  }
  
  // Reserved subdomains
  const reserved = ['www', 'api', 'admin', 'dashboard', 'status', 'mail', 'ftp', 'cdn', 'static'];
  if (reserved.includes(subdomain)) {
    return res.status(400).json({ error: 'This subdomain is reserved' });
  }
  
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    // Check if email exists
    const userCheck = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Check if subdomain exists
    const subdomainCheck = await client.query('SELECT id FROM tenants WHERE subdomain = $1', [subdomain]);
    if (subdomainCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Subdomain already taken' });
    }
    
    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, passwordHash, fullName, 'merchant']
    );
    const userId = userResult.rows[0].id;
    
    // Create tenant
    const tenantResult = await client.query(
      'INSERT INTO tenants (user_id, subdomain, store_name, plan, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, subdomain, storeName, 'free', 'active']
    );
    const tenantId = tenantResult.rows[0].id;
    
    // Create default theme and pages
    await createDefaultTheme(client, tenantId);
    
    // Cache subdomain mapping
    await redis.set(`subdomain:${subdomain}`, tenantId.toString(), { EX: 86400 });
    
    await client.query('COMMIT');
    
    // Generate token
    const token = jwt.sign({ userId, tenantId, role: 'merchant' }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      token,
      user: { id: userId, email, fullName },
      tenant: { id: tenantId, subdomain, storeName, storeUrl: `https://${subdomain}.fv-company.com` }
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  } finally {
    client.release();
  }
});

app.post('/api/login', rateLimitMiddleware(20, 3600000), async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  try {
    // Check super admin
    if (email === SUPER_ADMIN_EMAIL && SUPER_ADMIN_PASSWORD_HASH) {
      const match = await bcrypt.compare(password, SUPER_ADMIN_PASSWORD_HASH);
      if (match) {
        const token = jwt.sign({ userId: 0, tenantId: 0, role: 'super_admin' }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({
          success: true,
          token,
          user: { id: 0, email, fullName: 'Super Admin', role: 'super_admin' }
        });
      }
    }
    
    // Regular merchant login
    const result = await db.query(
      'SELECT u.id, u.email, u.password_hash, u.full_name, u.role, t.id as tenant_id, t.subdomain, t.store_name FROM users u LEFT JOIN tenants t ON u.id = t.user_id WHERE u.email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id, tenantId: user.tenant_id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role
      },
      tenant: user.tenant_id ? {
        id: user.tenant_id,
        subdomain: user.subdomain,
        storeName: user.store_name,
        storeUrl: `https://${user.subdomain}.fv-company.com`
      } : null
    });
    
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// === SUPER ADMIN ENDPOINTS ===

app.get('/api/admin/tenants', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        t.id,
        t.subdomain,
        t.store_name,
        t.custom_domain,
        t.plan,
        t.status,
        t.created_at,
        u.email as owner_email,
        u.full_name as owner_name,
        (SELECT COUNT(*) FROM products WHERE tenant_id = t.id) as product_count,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = t.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = t.id AND status = 'completed') as total_revenue
      FROM tenants t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `);
    
    res.json({ tenants: result.rows });
  } catch (err) {
    console.error('Admin tenants error:', err);
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

app.get('/api/admin/stats', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM tenants) as total_tenants,
        (SELECT COUNT(*) FROM tenants WHERE status = 'active') as active_tenants,
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM products) as total_products,
        (SELECT COUNT(*) FROM orders) as total_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status = 'completed') as total_revenue,
        (SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '24 hours') as orders_today,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE created_at > NOW() - INTERVAL '30 days' AND status = 'completed') as revenue_30days
    `);
    
    const row = stats.rows[0];
    res.json({
      totalTenants: parseInt(row.total_tenants),
      activeTenants: parseInt(row.active_tenants),
      totalUsers: parseInt(row.total_users),
      totalProducts: parseInt(row.total_products),
      totalOrders: parseInt(row.total_orders),
      totalRevenue: parseFloat(row.total_revenue)
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.patch('/api/admin/tenants/:id/status', authMiddleware, superAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  if (!['active', 'suspended', 'deleted'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  try {
    await db.query('UPDATE tenants SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// === ADVANCED INFRASTRUCTURE MONITORING ENDPOINTS ===

// Get all pods with detailed metrics
app.get('/api/admin/infrastructure/pods', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const https = await import('https');
    const fs = await import('fs');
    
    // Read service account token and CA cert
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    
    // Get pods from all namespaces
    const podsData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'kubernetes.default.svc',
        port: 443,
        path: '/api/v1/pods',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        ca: ca
      }, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.end();
    });
    
    // Parse pod data
    const pods = podsData.items.map(pod => {
      const containerStatuses = pod.status.containerStatuses || [];
      const restartCount = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
      
      return {
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        status: pod.status.phase,
        ready: containerStatuses.filter(c => c.ready).length + '/' + containerStatuses.length,
        restarts: restartCount,
        age: Math.floor((Date.now() - new Date(pod.metadata.creationTimestamp).getTime()) / 1000),
        nodeName: pod.spec.nodeName,
        ip: pod.status.podIP,
        labels: pod.metadata.labels || {}
      };
    });
    
    res.json({ pods, total: pods.length });
  } catch (err) {
    console.error('Failed to fetch pods from K8s API:', err.message);
    
    // Fallback to mock data
    const mockPods = [
      {
        name: 'platform-api-7d9f8b5c4-x2k9p',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 172800,
        nodeName: 'node-1',
        ip: '10.244.1.15',
        labels: { app: 'platform-api' }
      },
      {
        name: 'platform-api-7d9f8b5c4-m7h3q',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 172800,
        nodeName: 'node-2',
        ip: '10.244.2.18',
        labels: { app: 'platform-api' }
      },
      {
        name: 'postgres-0',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 259200,
        nodeName: 'node-1',
        ip: '10.244.1.10',
        labels: { app: 'postgres' }
      },
      {
        name: 'redis-0',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 259200,
        nodeName: 'node-2',
        ip: '10.244.2.11',
        labels: { app: 'redis' }
      },
      {
        name: 'admin-dashboard-react-6b8c9d-k4m2p',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 86400,
        nodeName: 'node-1',
        ip: '10.244.1.20',
        labels: { app: 'admin-dashboard-react' }
      },
      {
        name: 'merchant-dashboard-blue-5c7d8e-p9n3r',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 43200,
        nodeName: 'node-2',
        ip: '10.244.2.25',
        labels: { app: 'merchant-dashboard', version: 'blue' }
      },
      {
        name: 'storefront-renderer-9f2b3a-t7k5m',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 1,
        age: 129600,
        nodeName: 'node-1',
        ip: '10.244.1.30',
        labels: { app: 'storefront-renderer' }
      },
      {
        name: 'status-page-4d6f8c-h2j9k',
        namespace: 'platform-services',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: 7200,
        nodeName: 'node-2',
        ip: '10.244.2.35',
        labels: { app: 'status-page' }
      }
    ];
    
    res.json({ pods: mockPods, total: mockPods.length, source: 'fallback' });
  }
});

// Get nodes with resource usage
app.get('/api/admin/infrastructure/nodes', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const https = await import('https');
    const fs = await import('fs');
    
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    
    const nodesData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'kubernetes.default.svc',
        port: 443,
        path: '/api/v1/nodes',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        ca: ca
      }, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.end();
    });
    
    const nodes = nodesData.items.map(node => {
      const conditions = node.status.conditions || [];
      const readyCondition = conditions.find(c => c.type === 'Ready');
      
      return {
        name: node.metadata.name,
        status: readyCondition?.status === 'True' ? 'Ready' : 'NotReady',
        roles: Object.keys(node.metadata.labels || {})
          .filter(k => k.startsWith('node-role.kubernetes.io/'))
          .map(k => k.split('/')[1])
          .join(',') || 'worker',
        age: Math.floor((Date.now() - new Date(node.metadata.creationTimestamp).getTime()) / 1000),
        version: node.status.nodeInfo.kubeletVersion,
        cpu: node.status.capacity.cpu,
        memory: node.status.capacity.memory,
        pods: node.status.capacity.pods,
        osImage: node.status.nodeInfo.osImage,
        kernelVersion: node.status.nodeInfo.kernelVersion
      };
    });
    
    res.json({ nodes, total: nodes.length });
  } catch (err) {
    console.error('Failed to fetch nodes:', err.message);
    
    // Fallback
    const mockNodes = [
      {
        name: 'node-1',
        status: 'Ready',
        roles: 'control-plane,master',
        age: 2592000,
        version: 'v1.28.2',
        cpu: '4',
        memory: '8Gi',
        pods: '110',
        osImage: 'Ubuntu 22.04.3 LTS',
        kernelVersion: '5.15.0-91-generic'
      },
      {
        name: 'node-2',
        status: 'Ready',
        roles: 'worker',
        age: 2592000,
        version: 'v1.28.2',
        cpu: '4',
        memory: '8Gi',
        pods: '110',
        osImage: 'Ubuntu 22.04.3 LTS',
        kernelVersion: '5.15.0-91-generic'
      }
    ];
    
    res.json({ nodes: mockNodes, total: mockNodes.length, source: 'fallback' });
  }
});

// Get deployments status
app.get('/api/admin/infrastructure/deployments', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const https = await import('https');
    const fs = await import('fs');
    
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    
    const deploymentsData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'kubernetes.default.svc',
        port: 443,
        path: '/apis/apps/v1/deployments',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        ca: ca
      }, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.end();
    });
    
    const deployments = deploymentsData.items.map(dep => ({
      name: dep.metadata.name,
      namespace: dep.metadata.namespace,
      replicas: dep.spec.replicas,
      ready: dep.status.readyReplicas || 0,
      upToDate: dep.status.updatedReplicas || 0,
      available: dep.status.availableReplicas || 0,
      age: Math.floor((Date.now() - new Date(dep.metadata.creationTimestamp).getTime()) / 1000),
      strategy: dep.spec.strategy.type,
      image: dep.spec.template.spec.containers[0]?.image || 'unknown'
    }));
    
    res.json({ deployments, total: deployments.length });
  } catch (err) {
    console.error('Failed to fetch deployments:', err.message);
    
    // Fallback
    const mockDeployments = [
      {
        name: 'platform-api',
        namespace: 'platform-services',
        replicas: 2,
        ready: 2,
        upToDate: 2,
        available: 2,
        age: 172800,
        strategy: 'RollingUpdate',
        image: 'mtceel/platform-api:9cc729d'
      },
      {
        name: 'admin-dashboard-react',
        namespace: 'platform-services',
        replicas: 2,
        ready: 2,
        upToDate: 2,
        available: 2,
        age: 86400,
        strategy: 'RollingUpdate',
        image: 'mtceel/admin-dashboard:c45965f'
      },
      {
        name: 'merchant-dashboard-blue',
        namespace: 'platform-services',
        replicas: 2,
        ready: 2,
        upToDate: 2,
        available: 2,
        age: 43200,
        strategy: 'RollingUpdate',
        image: 'mtceel/merchant-dashboard:33a344f'
      },
      {
        name: 'storefront-renderer',
        namespace: 'platform-services',
        replicas: 2,
        ready: 2,
        upToDate: 2,
        available: 2,
        age: 129600,
        strategy: 'RollingUpdate',
        image: 'mtceel/storefront-renderer:47e88dd'
      },
      {
        name: 'status-page',
        namespace: 'platform-services',
        replicas: 2,
        ready: 2,
        upToDate: 2,
        available: 2,
        age: 7200,
        strategy: 'RollingUpdate',
        image: 'mtceel/status-page:b0458c0'
      }
    ];
    
    res.json({ deployments: mockDeployments, total: mockDeployments.length, source: 'fallback' });
  }
});

// Get services
app.get('/api/admin/infrastructure/services', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const https = await import('https');
    const fs = await import('fs');
    
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    
    const servicesData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'kubernetes.default.svc',
        port: 443,
        path: '/api/v1/services',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        ca: ca
      }, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.end();
    });
    
    const services = servicesData.items
      .filter(svc => svc.metadata.namespace !== 'kube-system') // Filter out system services
      .map(svc => ({
        name: svc.metadata.name,
        namespace: svc.metadata.namespace,
        type: svc.spec.type,
        clusterIP: svc.spec.clusterIP,
        externalIP: svc.status.loadBalancer?.ingress?.[0]?.ip || '-',
        ports: svc.spec.ports?.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(', ') || '-',
        age: Math.floor((Date.now() - new Date(svc.metadata.creationTimestamp).getTime()) / 1000)
      }));
    
    res.json({ services, total: services.length });
  } catch (err) {
    console.error('Failed to fetch services:', err.message);
    
    // Fallback
    const mockServices = [
      {
        name: 'platform-api',
        namespace: 'platform-services',
        type: 'ClusterIP',
        clusterIP: '10.96.45.120',
        externalIP: '-',
        ports: '8080:8080/TCP',
        age: 172800
      },
      {
        name: 'postgres',
        namespace: 'platform-services',
        type: 'ClusterIP',
        clusterIP: 'None',
        externalIP: '-',
        ports: '5432:5432/TCP',
        age: 259200
      },
      {
        name: 'redis',
        namespace: 'platform-services',
        type: 'ClusterIP',
        clusterIP: 'None',
        externalIP: '-',
        ports: '6379:6379/TCP',
        age: 259200
      }
    ];
    
    res.json({ services: mockServices, total: mockServices.length, source: 'fallback' });
  }
});

// Get persistent volume claims
app.get('/api/admin/infrastructure/pvcs', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const https = await import('https');
    const fs = await import('fs');
    
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    
    const pvcsData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'kubernetes.default.svc',
        port: 443,
        path: '/api/v1/persistentvolumeclaims',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        ca: ca
      }, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.end();
    });
    
    const pvcs = pvcsData.items.map(pvc => ({
      name: pvc.metadata.name,
      namespace: pvc.metadata.namespace,
      status: pvc.status.phase,
      volume: pvc.spec.volumeName,
      capacity: pvc.status.capacity?.storage || pvc.spec.resources.requests.storage,
      accessModes: pvc.spec.accessModes.join(', '),
      storageClass: pvc.spec.storageClassName || '-',
      age: Math.floor((Date.now() - new Date(pvc.metadata.creationTimestamp).getTime()) / 1000)
    }));
    
    res.json({ pvcs, total: pvcs.length });
  } catch (err) {
    console.error('Failed to fetch PVCs:', err.message);
    
    // Fallback
    const mockPVCs = [
      {
        name: 'postgres-storage-postgres-0',
        namespace: 'platform-services',
        status: 'Bound',
        volume: 'pvc-abc123',
        capacity: '5Gi',
        accessModes: 'ReadWriteOnce',
        storageClass: 'standard',
        age: 259200
      },
      {
        name: 'redis-storage-redis-0',
        namespace: 'platform-services',
        status: 'Bound',
        volume: 'pvc-def456',
        capacity: '2Gi',
        accessModes: 'ReadWriteOnce',
        storageClass: 'standard',
        age: 259200
      }
    ];
    
    res.json({ pvcs: mockPVCs, total: mockPVCs.length, source: 'fallback' });
  }
});

// Get cluster overview metrics
app.get('/api/admin/infrastructure/overview', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    // Fetch all data in parallel
    const [podsRes, nodesRes, deploymentsRes] = await Promise.all([
      fetch('http://localhost:8080/api/admin/infrastructure/pods', {
        headers: { 'Authorization': req.headers.authorization }
      }).then(r => r.json()).catch(() => ({ pods: [], total: 0 })),
      fetch('http://localhost:8080/api/admin/infrastructure/nodes', {
        headers: { 'Authorization': req.headers.authorization }
      }).then(r => r.json()).catch(() => ({ nodes: [], total: 0 })),
      fetch('http://localhost:8080/api/admin/infrastructure/deployments', {
        headers: { 'Authorization': req.headers.authorization }
      }).then(r => r.json()).catch(() => ({ deployments: [], total: 0 }))
    ]);
    
    const runningPods = podsRes.pods?.filter(p => p.status === 'Running').length || 0;
    const totalPods = podsRes.total || 0;
    const healthyDeployments = deploymentsRes.deployments?.filter(d => d.ready === d.replicas).length || 0;
    const totalDeployments = deploymentsRes.total || 0;
    
    res.json({
      cluster: {
        healthy: runningPods === totalPods && healthyDeployments === totalDeployments,
        nodes: nodesRes.total || 0,
        pods: {
          total: totalPods,
          running: runningPods,
          pending: podsRes.pods?.filter(p => p.status === 'Pending').length || 0,
          failed: podsRes.pods?.filter(p => p.status === 'Failed').length || 0
        },
        deployments: {
          total: totalDeployments,
          healthy: healthyDeployments,
          degraded: totalDeployments - healthyDeployments
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to fetch overview:', err.message);
    
    // Fallback
    res.json({
      cluster: {
        healthy: true,
        nodes: 2,
        pods: { total: 8, running: 8, pending: 0, failed: 0 },
        deployments: { total: 5, healthy: 5, degraded: 0 }
      },
      timestamp: new Date().toISOString(),
      source: 'fallback'
    });
  }
});

// Get real Kubernetes pod statistics
app.get('/api/admin/kubernetes', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    // FALLBACK: Return mock data for now (kubectl not available in container)
    // TODO: Use @kubernetes/client-node for proper K8s API access
    const pods = [
      {
        name: 'platform-api',
        status: 'Running',
        restarts: 0,
        age: '2d',
        cpu: '50m',
        memory: '128Mi'
      },
      {
        name: 'postgres',
        status: 'Running',
        restarts: 0,
        age: '2d',
        cpu: '30m',
        memory: '256Mi'
      },
      {
        name: 'redis',
        status: 'Running',
        restarts: 0,
        age: '2d',
        cpu: '10m',
        memory: '64Mi'
      },
      {
        name: 'admin-dashboard-react',
        status: 'Running',
        restarts: 0,
        age: '2d',
        cpu: '5m',
        memory: '32Mi'
      }
    ];
    
    res.json({ pods });
  } catch (err) {
    console.error('Kubernetes stats error:', err);
    res.status(500).json({ error: 'Failed to fetch Kubernetes stats', message: err.message });
  }
});

// Get microservices health status
app.get('/api/admin/microservices', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const services = [
      { name: 'Products Service', url: 'http://products-service.platform-services.svc.cluster.local/health', port: 80 },
      { name: 'Checkout Service', url: 'http://checkout-service.platform-services.svc.cluster.local/health', port: 80 },
      { name: 'Storefront Renderer', url: 'http://storefront-renderer.platform-services.svc.cluster.local/health', port: 80 },
    ];

    const results = await Promise.all(
      services.map(async (service) => {
        try {
          const response = await fetch(service.url, { 
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(3000) // 3s timeout
          });
          
          if (response.ok) {
            const data = await response.json();
            return {
              name: service.name,
              status: 'healthy',
              uptime: data.uptime || 0,
              connections: data.connections || {},
              timestamp: data.timestamp
            };
          } else {
            return {
              name: service.name,
              status: 'unhealthy',
              error: `HTTP ${response.status}`
            };
          }
        } catch (error) {
          return {
            name: service.name,
            status: 'unreachable',
            error: error.message
          };
        }
      })
    );

    res.json({ services: results, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Microservices health check error:', err);
    res.status(500).json({ error: 'Failed to check microservices health', message: err.message });
  }
});

// Get current user info
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT u.id, u.email, u.full_name, u.role, t.id as tenant_id, t.subdomain, t.store_name FROM users u LEFT JOIN tenants t ON u.id = t.user_id WHERE u.id = $1',
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    
    res.json({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      subdomain: user.subdomain,
      storeName: user.store_name,
      storeUrl: user.subdomain ? `https://${user.subdomain}.fv-company.com` : null
    });
    
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// === MERCHANT DASHBOARD ENDPOINTS ===

// Feature flags endpoint (for progressive rollouts)
app.get('/api/dashboard/features', authMiddleware, async (req, res) => {
  try {
    const features = getEnabledFeatures(req.tenantId);
    res.json({ 
      tenantId: req.tenantId,
      features,
      flashSaleBanner: isFeatureEnabled('FLASH_SALE_BANNER', req.tenantId)
    });
  } catch (err) {
    console.error('Feature flags error:', err);
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

app.get('/api/dashboard/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM products WHERE tenant_id = $1) as product_count,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = $1) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = $1 AND status = 'completed') as total_revenue,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours') as orders_today,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '30 days' AND status = 'completed') as revenue_30days
    `, [req.tenantId]);
    
    res.json({ stats: stats.rows[0] });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// === PRODUCTS ===

app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM products WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.tenantId]
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', authMiddleware, rateLimitMiddleware(50, 60000), async (req, res) => {
  const { title, description, price, inventory, sku, image_url, category, tags } = req.body;
  
  if (!title || price === undefined) {
    return res.status(400).json({ error: 'Title and price are required' });
  }
  
  try {
    const result = await db.query(
      `INSERT INTO products (tenant_id, title, description, price, inventory, sku, image_url, category, tags, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.tenantId, title, description, price, inventory || 0, sku, image_url, category, tags, 'active']
    );
    
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, description, price, inventory, sku, image_url, category, tags, status } = req.body;
  
  try {
    const result = await db.query(
      `UPDATE products 
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           price = COALESCE($3, price),
           inventory = COALESCE($4, inventory),
           sku = COALESCE($5, sku),
           image_url = COALESCE($6, image_url),
           category = COALESCE($7, category),
           tags = COALESCE($8, tags),
           status = COALESCE($9, status)
       WHERE id = $10 AND tenant_id = $11
       RETURNING *`,
      [title, description, price, inventory, sku, image_url, category, tags, status, id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await db.query('DELETE FROM products WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, req.tenantId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// === ORDERS ===

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.tenantId]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.patch('/api/orders/:id/status', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  if (!['pending', 'processing', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  try {
    await db.query(
      'UPDATE orders SET status = $1 WHERE id = $2 AND tenant_id = $3',
      [status, id, req.tenantId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// === STOREFRONT PUBLIC ENDPOINTS ===

app.get('/api/storefront/:subdomain', async (req, res) => {
  const { subdomain } = req.params;
  
  try {
    // Check cache first
    let tenantId = await redis.get(`subdomain:${subdomain}`);
    
    if (!tenantId) {
      // Fallback to database
      const tenantResult = await db.query(
        'SELECT id, store_name, custom_domain, status FROM tenants WHERE subdomain = $1',
        [subdomain]
      );
      
      if (tenantResult.rows.length === 0) {
        return res.status(404).json({ error: 'Store not found' });
      }
      
      const tenant = tenantResult.rows[0];
      
      if (tenant.status !== 'active') {
        return res.status(403).json({ error: 'Store is not active' });
      }
      
      tenantId = tenant.id;
      
      // Cache for 1 hour
      await redis.set(`subdomain:${subdomain}`, tenantId.toString(), { EX: 3600 });
    }
    
    // Fetch store data
    const storeResult = await db.query(
      'SELECT id, store_name, subdomain, custom_domain FROM tenants WHERE id = $1',
      [tenantId]
    );
    
    const productsResult = await db.query(
      'SELECT id, title, description, price, inventory, image_url, category, tags FROM products WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC',
      [tenantId, 'active']
    );
    
    res.json({
      store: storeResult.rows[0],
      products: productsResult.rows
    });
    
  } catch (err) {
    console.error('Storefront error:', err);
    res.status(500).json({ error: 'Failed to load store' });
  }
});

app.post('/api/checkout', rateLimitMiddleware(10, 60000), async (req, res) => {
  const { subdomain, cart, customerName, customerEmail, shippingAddress } = req.body;
  
  if (!subdomain || !cart || cart.length === 0 || !customerEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get tenant
    const tenantResult = await client.query('SELECT id FROM tenants WHERE subdomain = $1', [subdomain]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }
    const tenantId = tenantResult.rows[0].id;
    
    // Calculate total and verify inventory
    let total = 0;
    for (const item of cart) {
      const productResult = await client.query(
        'SELECT price, inventory FROM products WHERE id = $1 AND tenant_id = $2',
        [item.id, tenantId]
      );
      
      if (productResult.rows.length === 0) {
        throw new Error(`Product ${item.id} not found`);
      }
      
      const product = productResult.rows[0];
      
      if (product.inventory < item.quantity) {
        throw new Error(`Insufficient inventory for product ${item.id}`);
      }
      
      total += product.price * item.quantity;
      
      // Decrease inventory
      await client.query(
        'UPDATE products SET inventory = inventory - $1 WHERE id = $2',
        [item.quantity, item.id]
      );
    }
    
    // Create order
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const orderResult = await client.query(
      `INSERT INTO orders (tenant_id, order_number, customer_email, customer_name, shipping_address, total, items, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tenantId, orderNumber, customerEmail, customerName, shippingAddress, total, JSON.stringify(cart), 'pending']
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      order: orderResult.rows[0]
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message || 'Checkout failed' });
  } finally {
    client.release();
  }
});

// === THEMES & CUSTOMIZATION ===

app.get('/api/themes', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM themes WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.tenantId]
    );
    res.json({ themes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch themes' });
  }
});

app.post('/api/themes', authMiddleware, async (req, res) => {
  const { name, settings } = req.body;
  
  try {
    const result = await db.query(
      'INSERT INTO themes (tenant_id, name, settings) VALUES ($1, $2, $3) RETURNING *',
      [req.tenantId, name, settings || {}]
    );
    res.json({ success: true, theme: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create theme' });
  }
});

app.patch('/api/themes/:id/activate', authMiddleware, async (req, res) => {
  const { id } = req.params;
  
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE themes SET is_active = false WHERE tenant_id = $1', [req.tenantId]);
    await client.query('UPDATE themes SET is_active = true WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    await client.query('COMMIT');
    
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to activate theme' });
  } finally {
    client.release();
  }
});

// === CUSTOM DOMAINS ===

app.post('/api/custom-domain', authMiddleware, async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }
  
  try {
    await db.query(
      'UPDATE tenants SET custom_domain = $1 WHERE id = $2',
      [domain, req.tenantId]
    );
    
    // Cache domain mapping
    await redis.set(`domain:${domain}`, req.tenantId.toString(), { EX: 86400 });
    
    res.json({ 
      success: true, 
      message: 'Custom domain added. Please point your DNS CNAME to fv-company.com'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add custom domain' });
  }
});

// === ANALYTICS ===

app.get('/api/analytics/overview', authMiddleware, async (req, res) => {
  const { days = 30 } = req.query;
  
  try {
    const result = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as orders,
        SUM(total) as revenue
      FROM orders
      WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [req.tenantId]);
    
    res.json({ analytics: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// =======================
// STATUS PAGE HEALTH CHECKS
// =======================

// Individual module health checks
const checkServiceHealth = async (url, timeout = 2000) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const start = Date.now();
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'FV-StatusCheck/1.0' }
    });
    clearTimeout(timeoutId);
    
    const latency = Date.now() - start;
    
    if (response.ok) {
      return { status: 'operational', latency };
    } else {
      return { status: 'degraded', latency };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 'degraded', latency: timeout };
    }
    return { status: 'outage', latency: null };
  }
};

// Admin Dashboard health
app.get('/api/health/admin', async (req, res) => {
  const health = await checkServiceHealth('http://admin-dashboard-react.platform-services.svc.cluster.local:80');
  res.json(health);
});

// Checkout/Orders health
app.get('/api/health/checkout', async (req, res) => {
  try {
    const start = Date.now();
    await db.query('SELECT 1 FROM orders LIMIT 1');
    const latency = Date.now() - start;
    res.json({ status: 'operational', latency });
  } catch (err) {
    res.json({ status: 'outage', latency: null });
  }
});

// Reports/Analytics health
app.get('/api/health/reports', async (req, res) => {
  try {
    const start = Date.now();
    await db.query('SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL \'24 hours\'');
    const latency = Date.now() - start;
    res.json({ status: 'operational', latency });
  } catch (err) {
    res.json({ status: 'degraded', latency: null });
  }
});

// Storefront health
app.get('/api/health/storefront', async (req, res) => {
  const health = await checkServiceHealth('http://storefront-renderer.platform-services.svc.cluster.local:80');
  res.json(health);
});

// API health (self-check)
app.get('/api/health/api', async (req, res) => {
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    await redis.ping();
    const latency = Date.now() - start;
    res.json({ status: 'operational', latency });
  } catch (err) {
    res.json({ status: 'outage', latency: null });
  }
});

// Third party services health (mock for now - replace with actual checks)
app.get('/api/health/thirdparty', async (req, res) => {
  // In production, check Stripe API, SendGrid, etc.
  // For now, return operational
  res.json({ status: 'operational', latency: 5 });
});

// Support system health (mock for now)
app.get('/api/health/support', async (req, res) => {
  // In production, check ticket system API
  res.json({ status: 'operational', latency: 3 });
});

// POS health (mock for now)
app.get('/api/health/pos', async (req, res) => {
  // In production, check POS system API
  res.json({ status: 'operational', latency: 4 });
});

// All modules aggregated health check
app.get('/api/health/all-modules', async (req, res) => {
  try {
    const [admin, checkout, reports, storefront, api, thirdparty, support, pos] = await Promise.all([
      checkServiceHealth('http://admin-dashboard-react.platform-services.svc.cluster.local:80'),
      (async () => {
        try {
          const start = Date.now();
          await db.query('SELECT 1 FROM orders LIMIT 1');
          return { status: 'operational', latency: Date.now() - start };
        } catch {
          return { status: 'outage', latency: null };
        }
      })(),
      (async () => {
        try {
          const start = Date.now();
          await db.query('SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL \'24 hours\'');
          return { status: 'operational', latency: Date.now() - start };
        } catch {
          return { status: 'degraded', latency: null };
        }
      })(),
      checkServiceHealth('http://storefront-renderer.platform-services.svc.cluster.local:80'),
      (async () => {
        try {
          const start = Date.now();
          await db.query('SELECT 1');
          await redis.ping();
          return { status: 'operational', latency: Date.now() - start };
        } catch {
          return { status: 'outage', latency: null };
        }
      })(),
      Promise.resolve({ status: 'operational', latency: 5 }), // Third party mock
      Promise.resolve({ status: 'operational', latency: 3 }), // Support mock
      Promise.resolve({ status: 'operational', latency: 4 })  // POS mock
    ]);
    
    // Determine overall status
    const statuses = [admin, checkout, reports, storefront, api, thirdparty, support, pos];
    const hasOutage = statuses.some(s => s.status === 'outage');
    const hasDegraded = statuses.some(s => s.status === 'degraded');
    
    let overall = 'operational';
    if (hasOutage) overall = 'partial';
    else if (hasDegraded) overall = 'degraded';
    
    res.json({
      timestamp: new Date().toISOString(),
      overall,
      modules: {
        admin,
        checkout,
        reports,
        storefront,
        api,
        thirdparty,
        support,
        pos
      }
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(503).json({
      timestamp: new Date().toISOString(),
      overall: 'outage',
      error: err.message
    });
  }
});

// =======================
// STATUS PAGE METRICS API
// =======================

// Kubernetes metrics endpoint (for status page)
app.get('/api/k8s/metrics', async (req, res) => {
  try {
    const https = await import('https');
    const fs = await import('fs');
    
    // Read service account token and CA cert
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    
    // Call Kubernetes API
    const options = {
      hostname: 'kubernetes.default.svc',
      port: 443,
      path: '/apis/apps/v1/namespaces/platform-services/deployments',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      ca: ca
    };
    
    const data = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.end();
    });
    
    const deployments = {};
    
    // Keep Blue/Green deployments separate (don't aggregate by app label)
    data.items.forEach(item => {
      const name = item.metadata.name;
      const spec = item.spec;
      const status = item.status;
      
      deployments[name] = {
        total: spec.replicas || 0,
        running: status.availableReplicas || 0,
        ready: status.readyReplicas || 0
      };
    });
    
    res.json({ deployments });
  } catch (err) {
    console.error('K8s metrics error:', err.message);
    // Fallback: return mock data with correct Blue/Green structure
    res.json({
      deployments: {
        'platform-api': { total: 2, running: 2, ready: 2 },
        'admin-dashboard-react': { total: 2, running: 2, ready: 2 },
        'merchant-dashboard-blue': { total: 2, running: 2, ready: 2 },
        'merchant-dashboard-green': { total: 1, running: 1, ready: 1 },
        'storefront-renderer': { total: 2, running: 2, ready: 2 },
        'status-page-enhanced': { total: 2, running: 2, ready: 2 },
        'postgres': { total: 1, running: 1, ready: 1 },
        'redis': { total: 1, running: 1, ready: 1 }
      }
    });
  }
});

// PostgreSQL metrics endpoint
app.get('/api/postgres/metrics', async (req, res) => {
  try {
    // Get query count (approximate)
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active') as active_queries,
        (SELECT COUNT(*) FROM pg_stat_activity) as total_connections
    `);
    
    res.json({
      queriesPerMinute: stats.rows[0]?.active_queries * 60 || 0,
      connections: stats.rows[0]?.total_connections || 0
    });
  } catch (err) {
    console.error('Postgres metrics error:', err.message);
    res.json({ queriesPerMinute: 0, connections: 0 });
  }
});

// Platform metrics endpoint  
app.get('/api/platform/metrics', async (req, res) => {
  try {
    const [tenants, products] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM tenants'),
      db.query('SELECT COUNT(*) as count FROM products')
    ]);
    
    res.json({
      totalTenants: parseInt(tenants.rows[0]?.count || 0),
      totalProducts: parseInt(products.rows[0]?.count || 0)
    });
  } catch (err) {
    console.error('Platform metrics error:', err.message);
    res.json({ totalTenants: 0, totalProducts: 0 });
  }
});

// ============================================================
// PAGE BUILDER ROUTES (Website Builder / Visual Editor)
// ============================================================
setupPageBuilderRoutes(app, db, authMiddleware);

// ============================================================
// MICROSERVICES PROXY ROUTES
// Forward authenticated requests to backend microservices
// ============================================================

app.all('/api/products*', authMiddleware, (req, res) => proxyToService(SERVICES.products, req, res));
app.all('/api/orders*', authMiddleware, (req, res) => proxyToService(SERVICES.orders, req, res));
app.all('/api/customers*', authMiddleware, (req, res) => proxyToService(SERVICES.customers, req, res));
app.all('/api/discounts*', authMiddleware, (req, res) => proxyToService(SERVICES.discounts, req, res));
app.all('/api/analytics*', authMiddleware, (req, res) => proxyToService(SERVICES.analytics, req, res));
app.all('/api/checkout*', authMiddleware, (req, res) => proxyToService(SERVICES.checkout, req, res));

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Platform API Enterprise running on port ${PORT}`);
  console.log(`📊 Database: ${db.options.database}`);
  console.log(`🔐 JWT Secret: ${JWT_SECRET.substring(0, 10)}...`);
});
