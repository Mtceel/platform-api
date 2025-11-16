/**
 * Website Builder API
 * Shopify-style visual page editor with drag-and-drop blocks
 * 
 * Security:
 * - JSON-based templates (no code execution)
 * - Tenant isolation on all queries
 * - Input validation and sanitization
 * - XSS protection via template escaping
 */

import Handlebars from 'handlebars';

// Register Handlebars helpers
Handlebars.registerHelper('if', function(conditional, options) {
  if (conditional) {
    return options.fn(this);
  }
  return options.inverse(this);
});

Handlebars.registerHelper('each', function(context, options) {
  let ret = '';
  for (let i = 0, j = context.length; i < j; i++) {
    ret = ret + options.fn(context[i]);
  }
  return ret;
});

/**
 * Initialize website builder routes
 */
export function setupPageBuilderRoutes(app, db, authMiddleware) {
  
  // ============================================================
  // THEMES API
  // ============================================================
  
  /**
   * GET /api/themes - Get all themes for tenant
   */
  app.get('/api/themes', authMiddleware, async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        'SELECT * FROM themes WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId]
      );
      
      res.json({ themes: result.rows });
    } catch (error) {
      console.error('Get themes error:', error);
      res.status(500).json({ error: 'Failed to fetch themes' });
    }
  });
  
  /**
   * GET /api/themes/:id - Get single theme
   */
  app.get('/api/themes/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        'SELECT * FROM themes WHERE id = $1 AND tenant_id = $2',
        [id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Theme not found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Get theme error:', error);
      res.status(500).json({ error: 'Failed to fetch theme' });
    }
  });
  
  /**
   * POST /api/themes - Create new theme
   */
  app.post('/api/themes', authMiddleware, async (req, res) => {
    try {
      const { name, settings } = req.body;
      const tenantId = req.user.tenantId;
      
      if (!name) {
        return res.status(400).json({ error: 'Theme name is required' });
      }
      
      const result = await db.query(
        'INSERT INTO themes (tenant_id, name, settings) VALUES ($1, $2, $3) RETURNING *',
        [tenantId, name, settings || {}]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create theme error:', error);
      if (error.code === '23505') { // Unique constraint violation
        return res.status(400).json({ error: 'Theme name already exists' });
      }
      res.status(500).json({ error: 'Failed to create theme' });
    }
  });
  
  /**
   * PUT /api/themes/:id - Update theme
   */
  app.put('/api/themes/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, settings, is_active } = req.body;
      const tenantId = req.user.tenantId;
      
      // If activating this theme, deactivate others
      if (is_active) {
        await db.query(
          'UPDATE themes SET is_active = false WHERE tenant_id = $1',
          [tenantId]
        );
      }
      
      const result = await db.query(
        'UPDATE themes SET name = COALESCE($1, name), settings = COALESCE($2, settings), is_active = COALESCE($3, is_active), updated_at = NOW() WHERE id = $4 AND tenant_id = $5 RETURNING *',
        [name, settings, is_active, id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Theme not found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update theme error:', error);
      res.status(500).json({ error: 'Failed to update theme' });
    }
  });
  
  /**
   * DELETE /api/themes/:id - Delete theme
   */
  app.delete('/api/themes/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        'DELETE FROM themes WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Theme not found' });
      }
      
      res.json({ message: 'Theme deleted successfully' });
    } catch (error) {
      console.error('Delete theme error:', error);
      res.status(500).json({ error: 'Failed to delete theme' });
    }
  });
  
  // ============================================================
  // PAGES API
  // ============================================================
  
  /**
   * GET /api/pages - Get all pages for tenant
   */
  app.get('/api/pages', authMiddleware, async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        `SELECT p.*, t.name as theme_name 
         FROM pages p 
         LEFT JOIN themes t ON p.theme_id = t.id 
         WHERE p.tenant_id = $1 
         ORDER BY p.created_at DESC`,
        [tenantId]
      );
      
      res.json({ pages: result.rows });
    } catch (error) {
      console.error('Get pages error:', error);
      res.status(500).json({ error: 'Failed to fetch pages' });
    }
  });
  
  /**
   * GET /api/pages/:id - Get single page
   */
  app.get('/api/pages/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        'SELECT * FROM pages WHERE id = $1 AND tenant_id = $2',
        [id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Page not found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Get page error:', error);
      res.status(500).json({ error: 'Failed to fetch page' });
    }
  });
  
  /**
   * GET /api/pages/slug/:slug - Get page by slug (for storefront rendering)
   */
  app.get('/api/pages/slug/:slug', async (req, res) => {
    try {
      const { slug } = req.params;
      const subdomain = req.headers['x-tenant-subdomain'] || req.query.subdomain;
      
      if (!subdomain) {
        return res.status(400).json({ error: 'Subdomain required' });
      }
      
      // Get tenant from subdomain
      const tenantResult = await db.query(
        'SELECT id FROM tenants WHERE subdomain = $1',
        [subdomain]
      );
      
      if (tenantResult.rows.length === 0) {
        return res.status(404).json({ error: 'Store not found' });
      }
      
      const tenantId = tenantResult.rows[0].id;
      
      // Get published page
      const result = await db.query(
        'SELECT * FROM pages WHERE tenant_id = $1 AND slug = $2 AND is_published = true',
        [tenantId, slug]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Page not found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Get page by slug error:', error);
      res.status(500).json({ error: 'Failed to fetch page' });
    }
  });
  
  /**
   * POST /api/pages - Create new page
   */
  app.post('/api/pages', authMiddleware, async (req, res) => {
    try {
      const { slug, title, meta_description, theme_id, blocks } = req.body;
      const tenantId = req.user.tenantId;
      
      if (!slug || !title) {
        return res.status(400).json({ error: 'Slug and title are required' });
      }
      
      // Validate slug format (alphanumeric and hyphens only)
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid slug format. Use lowercase letters, numbers, and hyphens only.' });
      }
      
      const result = await db.query(
        'INSERT INTO pages (tenant_id, theme_id, slug, title, meta_description, blocks) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [tenantId, theme_id || null, slug, title, meta_description || '', blocks || []]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Create page error:', error);
      if (error.code === '23505') { // Unique constraint violation
        return res.status(400).json({ error: 'Page with this slug already exists' });
      }
      res.status(500).json({ error: 'Failed to create page' });
    }
  });
  
  /**
   * PUT /api/pages/:id - Update page
   */
  app.put('/api/pages/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { slug, title, meta_description, theme_id, blocks, is_published, seo_settings } = req.body;
      const tenantId = req.user.tenantId;
      
      // Save version before updating
      const existingPage = await db.query(
        'SELECT blocks FROM pages WHERE id = $1 AND tenant_id = $2',
        [id, tenantId]
      );
      
      if (existingPage.rows.length > 0) {
        const latestVersion = await db.query(
          'SELECT MAX(version_number) as max_version FROM page_versions WHERE page_id = $1',
          [id]
        );
        
        const nextVersion = (latestVersion.rows[0].max_version || 0) + 1;
        
        await db.query(
          'INSERT INTO page_versions (page_id, version_number, blocks, created_by) VALUES ($1, $2, $3, $4)',
          [id, nextVersion, existingPage.rows[0].blocks, req.user.userId]
        );
      }
      
      // Update page
      const result = await db.query(
        `UPDATE pages SET 
          slug = COALESCE($1, slug), 
          title = COALESCE($2, title), 
          meta_description = COALESCE($3, meta_description),
          theme_id = COALESCE($4, theme_id),
          blocks = COALESCE($5, blocks),
          is_published = COALESCE($6, is_published),
          seo_settings = COALESCE($7, seo_settings),
          updated_at = NOW(),
          published_at = CASE WHEN $6 = true AND is_published = false THEN NOW() ELSE published_at END
         WHERE id = $8 AND tenant_id = $9 RETURNING *`,
        [slug, title, meta_description, theme_id, blocks, is_published, seo_settings, id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Page not found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Update page error:', error);
      res.status(500).json({ error: 'Failed to update page' });
    }
  });
  
  /**
   * DELETE /api/pages/:id - Delete page
   */
  app.delete('/api/pages/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        'DELETE FROM pages WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Page not found' });
      }
      
      res.json({ message: 'Page deleted successfully' });
    } catch (error) {
      console.error('Delete page error:', error);
      res.status(500).json({ error: 'Failed to delete page' });
    }
  });
  
  // ============================================================
  // BLOCK TYPES API
  // ============================================================
  
  /**
   * GET /api/block-types - Get all available block types
   */
  app.get('/api/block-types', authMiddleware, async (req, res) => {
    try {
      const result = await db.query(
        'SELECT id, name, category, icon, default_config, schema FROM block_types WHERE is_enabled = true ORDER BY category, name'
      );
      
      // Group by category
      const blocksByCategory = {};
      for (const block of result.rows) {
        if (!blocksByCategory[block.category]) {
          blocksByCategory[block.category] = [];
        }
        blocksByCategory[block.category].push(block);
      }
      
      res.json({ blockTypes: result.rows, byCategory: blocksByCategory });
    } catch (error) {
      console.error('Get block types error:', error);
      res.status(500).json({ error: 'Failed to fetch block types' });
    }
  });
  
  // ============================================================
  // PAGE RENDERING (For preview and storefront)
  // ============================================================
  
  /**
   * POST /api/pages/render - Render page blocks to HTML (preview mode)
   */
  app.post('/api/pages/render', authMiddleware, async (req, res) => {
    try {
      const { blocks } = req.body;
      
      if (!Array.isArray(blocks)) {
        return res.status(400).json({ error: 'Blocks must be an array' });
      }
      
      const html = await renderBlocks(blocks, db);
      res.json({ html });
    } catch (error) {
      console.error('Render page error:', error);
      res.status(500).json({ error: 'Failed to render page' });
    }
  });
  
  /**
   * GET /api/storefront/page/:slug - Render published page for storefront
   */
  app.get('/api/storefront/page/:slug', async (req, res) => {
    try {
      const { slug } = req.params;
      const subdomain = req.headers['x-tenant-subdomain'] || req.query.subdomain;
      
      if (!subdomain) {
        return res.status(400).json({ error: 'Subdomain required' });
      }
      
      // Get tenant
      const tenantResult = await db.query(
        'SELECT id, store_name FROM tenants WHERE subdomain = $1',
        [subdomain]
      );
      
      if (tenantResult.rows.length === 0) {
        return res.status(404).json({ error: 'Store not found' });
      }
      
      const tenant = tenantResult.rows[0];
      
      // Get published page
      const pageResult = await db.query(
        'SELECT * FROM pages WHERE tenant_id = $1 AND slug = $2 AND is_published = true',
        [tenant.id, slug]
      );
      
      if (pageResult.rows.length === 0) {
        return res.status(404).json({ error: 'Page not found' });
      }
      
      const page = pageResult.rows[0];
      const html = await renderBlocks(page.blocks, db);
      
      res.json({
        page: {
          title: page.title,
          slug: page.slug,
          meta_description: page.meta_description,
          seo_settings: page.seo_settings
        },
        html,
        storeName: tenant.store_name
      });
    } catch (error) {
      console.error('Storefront page error:', error);
      res.status(500).json({ error: 'Failed to load page' });
    }
  });
  
  // ============================================================
  // ASSETS API (File Upload)
  // ============================================================
  
  /**
   * GET /api/assets - Get all assets for tenant
   */
  app.get('/api/assets', authMiddleware, async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      const { limit = 50, offset = 0 } = req.query;
      
      const result = await db.query(
        'SELECT * FROM assets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [tenantId, limit, offset]
      );
      
      const countResult = await db.query(
        'SELECT COUNT(*) FROM assets WHERE tenant_id = $1',
        [tenantId]
      );
      
      res.json({
        assets: result.rows,
        total: parseInt(countResult.rows[0].count)
      });
    } catch (error) {
      console.error('Get assets error:', error);
      res.status(500).json({ error: 'Failed to fetch assets' });
    }
  });
  
  /**
   * POST /api/assets/upload - Upload asset
   * Note: Requires multipart/form-data middleware (multer)
   * For now, returns placeholder - implement file upload in next step
   */
  app.post('/api/assets/upload', authMiddleware, async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      
      // TODO: Implement actual file upload with multer
      // For now, return error
      res.status(501).json({ 
        error: 'File upload not yet implemented',
        message: 'Use external image URLs for now. S3 upload coming soon.'
      });
    } catch (error) {
      console.error('Upload asset error:', error);
      res.status(500).json({ error: 'Failed to upload asset' });
    }
  });
  
  /**
   * DELETE /api/assets/:id - Delete asset
   */
  app.delete('/api/assets/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.user.tenantId;
      
      const result = await db.query(
        'DELETE FROM assets WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [id, tenantId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Asset not found' });
      }
      
      // TODO: Delete file from S3/local storage
      
      res.json({ message: 'Asset deleted successfully' });
    } catch (error) {
      console.error('Delete asset error:', error);
      res.status(500).json({ error: 'Failed to delete asset' });
    }
  });
}

/**
 * Render blocks to HTML
 */
async function renderBlocks(blocks, db) {
  if (!Array.isArray(blocks)) {
    return '';
  }
  
  let html = '';
  
  // Get all block type templates
  const blockTypesResult = await db.query(
    'SELECT name, template FROM block_types WHERE is_enabled = true'
  );
  
  const templates = {};
  for (const bt of blockTypesResult.rows) {
    templates[bt.name] = Handlebars.compile(bt.template);
  }
  
  // Render each block
  for (const block of blocks) {
    const { type, config } = block;
    
    if (!templates[type]) {
      console.warn(`Unknown block type: ${type}`);
      continue;
    }
    
    try {
      // Escape user input to prevent XSS
      const safeConfig = escapeBlockConfig(config);
      
      // Add year helper for footer
      safeConfig.year = new Date().getFullYear();
      
      // Add JSON config for dynamic blocks (product-grid, etc)
      safeConfig.jsonConfig = JSON.stringify(config);
      
      html += templates[type](safeConfig);
    } catch (error) {
      console.error(`Error rendering block ${type}:`, error);
      html += `<!-- Error rendering ${type} block -->`;
    }
  }
  
  return html;
}

/**
 * Escape user input to prevent XSS attacks
 */
function escapeBlockConfig(config) {
  if (typeof config !== 'object' || config === null) {
    return config;
  }
  
  const escaped = {};
  
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      // Don't escape HTML content field (allow rich text)
      if (key === 'content') {
        escaped[key] = value;
      } else {
        // Escape other string fields
        escaped[key] = escapeHtml(value);
      }
    } else if (Array.isArray(value)) {
      escaped[key] = value.map(item => 
        typeof item === 'object' ? escapeBlockConfig(item) : escapeHtml(String(item))
      );
    } else if (typeof value === 'object') {
      escaped[key] = escapeBlockConfig(value);
    } else {
      escaped[key] = value;
    }
  }
  
  return escaped;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
