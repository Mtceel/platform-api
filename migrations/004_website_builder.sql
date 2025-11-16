-- Website Builder System
-- Shopify-style visual page editor with drag-and-drop blocks

-- ============================================================
-- THEMES TABLE - Store theme configurations
-- ============================================================
CREATE TABLE IF NOT EXISTS themes (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT 'Default Theme',
  is_active BOOLEAN DEFAULT false,
  settings JSONB DEFAULT '{}', -- Global theme settings (colors, fonts, etc)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX idx_themes_tenant ON themes(tenant_id);
CREATE INDEX idx_themes_active ON themes(tenant_id, is_active);

-- ============================================================
-- PAGES TABLE - Store pages with JSON block configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  theme_id INTEGER REFERENCES themes(id) ON DELETE SET NULL,
  slug VARCHAR(255) NOT NULL, -- URL path (e.g., 'about', 'contact')
  title VARCHAR(500) NOT NULL,
  meta_description TEXT,
  is_published BOOLEAN DEFAULT false,
  blocks JSONB DEFAULT '[]', -- Array of block configurations
  seo_settings JSONB DEFAULT '{}', -- SEO metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP,
  UNIQUE(tenant_id, slug)
);

CREATE INDEX idx_pages_tenant ON pages(tenant_id);
CREATE INDEX idx_pages_published ON pages(tenant_id, is_published);
CREATE INDEX idx_pages_slug ON pages(tenant_id, slug);

-- ============================================================
-- BLOCK_TYPES TABLE - Available block types (admin-managed)
-- ============================================================
CREATE TABLE IF NOT EXISTS block_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE, -- 'hero', 'text', 'gallery', etc
  category VARCHAR(50) NOT NULL, -- 'layout', 'content', 'media', 'ecommerce'
  icon VARCHAR(50), -- Icon name for UI
  template TEXT NOT NULL, -- HTML template with {{variable}} placeholders
  default_config JSONB DEFAULT '{}', -- Default configuration
  schema JSONB DEFAULT '{}', -- JSON schema for validation
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insert default block types
INSERT INTO block_types (name, category, icon, template, default_config, schema) VALUES
-- LAYOUT BLOCKS
('hero', 'layout', 'layout-grid', '<section class="hero" style="background-image: url({{backgroundImage}}); background-size: cover; background-position: center; height: {{height}}; display: flex; align-items: center; justify-content: center; color: {{textColor}};">
  <div class="hero-content" style="text-align: center; max-width: 800px; padding: 40px;">
    <h1 style="font-size: 3rem; margin-bottom: 1rem;">{{title}}</h1>
    <p style="font-size: 1.5rem; margin-bottom: 2rem;">{{subtitle}}</p>
    {{#if buttonText}}
    <a href="{{buttonLink}}" class="btn btn-primary" style="padding: 15px 40px; background: {{buttonColor}}; color: white; text-decoration: none; border-radius: 5px; font-size: 1.2rem;">{{buttonText}}</a>
    {{/if}}
  </div>
</section>', 
'{"title": "Welcome to our store", "subtitle": "Discover amazing products", "backgroundImage": "/assets/hero-default.jpg", "height": "600px", "textColor": "#ffffff", "buttonText": "Shop Now", "buttonLink": "/products", "buttonColor": "#667eea"}',
'{"type": "object", "properties": {"title": {"type": "string"}, "subtitle": {"type": "string"}, "backgroundImage": {"type": "string"}, "height": {"type": "string"}, "textColor": {"type": "string"}, "buttonText": {"type": "string"}, "buttonLink": {"type": "string"}, "buttonColor": {"type": "string"}}}'),

('section-two-column', 'layout', 'columns', '<section class="two-column" style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px; padding: 60px 20px; max-width: 1200px; margin: 0 auto;">
  <div class="column-left">
    <img src="{{leftImage}}" alt="{{leftImageAlt}}" style="width: 100%; border-radius: 8px;">
  </div>
  <div class="column-right" style="display: flex; flex-direction: column; justify-content: center;">
    <h2 style="font-size: 2rem; margin-bottom: 1rem;">{{title}}</h2>
    <p style="font-size: 1.1rem; line-height: 1.6; color: #666;">{{description}}</p>
  </div>
</section>',
'{"title": "Our Story", "description": "We are passionate about delivering quality products...", "leftImage": "/assets/placeholder.jpg", "leftImageAlt": "Company image"}',
'{"type": "object", "properties": {"title": {"type": "string"}, "description": {"type": "string"}, "leftImage": {"type": "string"}, "leftImageAlt": {"type": "string"}}}'),

-- CONTENT BLOCKS
('text', 'content', 'type', '<div class="text-block" style="max-width: {{maxWidth}}; margin: 0 auto; padding: 40px 20px;">
  <h2 style="font-size: {{headingSize}}; color: {{headingColor}}; margin-bottom: 1rem;">{{heading}}</h2>
  <div style="font-size: {{textSize}}; line-height: 1.6; color: {{textColor}};">{{content}}</div>
</div>',
'{"heading": "About Us", "content": "<p>Your content here...</p>", "maxWidth": "800px", "headingSize": "2rem", "headingColor": "#333", "textSize": "1rem", "textColor": "#666"}',
'{"type": "object", "properties": {"heading": {"type": "string"}, "content": {"type": "string"}, "maxWidth": {"type": "string"}, "headingSize": {"type": "string"}, "textSize": {"type": "string"}}}'),

('call-to-action', 'content', 'megaphone', '<section class="cta" style="background: {{backgroundColor}}; color: {{textColor}}; text-align: center; padding: 80px 20px;">
  <h2 style="font-size: 2.5rem; margin-bottom: 1rem;">{{title}}</h2>
  <p style="font-size: 1.2rem; margin-bottom: 2rem;">{{description}}</p>
  <a href="{{buttonLink}}" class="btn" style="padding: 15px 40px; background: {{buttonColor}}; color: white; text-decoration: none; border-radius: 5px; font-size: 1.1rem;">{{buttonText}}</a>
</section>',
'{"title": "Ready to get started?", "description": "Join thousands of happy customers", "buttonText": "Sign Up Now", "buttonLink": "/signup", "backgroundColor": "#667eea", "textColor": "#ffffff", "buttonColor": "#ffffff"}',
'{"type": "object"}'),

-- MEDIA BLOCKS
('image', 'media', 'image', '<div class="image-block" style="text-align: center; padding: 40px 20px;">
  <img src="{{src}}" alt="{{alt}}" style="max-width: {{maxWidth}}; width: 100%; height: auto; border-radius: {{borderRadius}};">
  {{#if caption}}
  <p style="margin-top: 1rem; color: #666; font-style: italic;">{{caption}}</p>
  {{/if}}
</div>',
'{"src": "/assets/placeholder.jpg", "alt": "Image description", "maxWidth": "100%", "borderRadius": "0px", "caption": ""}',
'{"type": "object"}'),

('gallery', 'media', 'images', '<div class="gallery" style="display: grid; grid-template-columns: repeat({{columns}}, 1fr); gap: {{gap}}; padding: 40px 20px; max-width: 1200px; margin: 0 auto;">
  {{#each images}}
  <div class="gallery-item">
    <img src="{{this.src}}" alt="{{this.alt}}" style="width: 100%; height: {{../height}}; object-fit: cover; border-radius: 8px;">
  </div>
  {{/each}}
</div>',
'{"columns": "3", "gap": "20px", "height": "300px", "images": [{"src": "/assets/placeholder.jpg", "alt": "Image 1"}, {"src": "/assets/placeholder.jpg", "alt": "Image 2"}, {"src": "/assets/placeholder.jpg", "alt": "Image 3"}]}',
'{"type": "object"}'),

('video', 'media', 'video', '<div class="video-block" style="max-width: {{maxWidth}}; margin: 0 auto; padding: 40px 20px;">
  {{#if youtubeId}}
  <iframe width="100%" height="{{height}}" src="https://www.youtube.com/embed/{{youtubeId}}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
  {{else}}
  <video width="100%" height="{{height}}" controls>
    <source src="{{videoUrl}}" type="video/mp4">
  </video>
  {{/if}}
</div>',
'{"videoUrl": "", "youtubeId": "", "height": "400px", "maxWidth": "1000px"}',
'{"type": "object"}'),

-- ECOMMERCE BLOCKS
('product-grid', 'ecommerce', 'shopping-bag', '<div class="product-grid" style="display: grid; grid-template-columns: repeat({{columns}}, 1fr); gap: 30px; padding: 40px 20px; max-width: 1200px; margin: 0 auto;" data-block-type="product-grid" data-config="{{jsonConfig}}">
  <!-- Products loaded dynamically via JavaScript -->
</div>',
'{"columns": "3", "limit": "6", "showPrice": true, "showAddToCart": true}',
'{"type": "object"}'),

('featured-product', 'ecommerce', 'star', '<section class="featured-product" style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px; padding: 60px 20px; max-width: 1200px; margin: 0 auto;" data-block-type="featured-product" data-product-id="{{productId}}">
  <!-- Product loaded dynamically -->
</section>',
'{"productId": "1"}',
'{"type": "object"}'),

-- NAVIGATION BLOCKS
('header', 'layout', 'menu', '<header style="background: {{backgroundColor}}; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
  <div style="max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center;">
    <div class="logo">
      <img src="{{logoUrl}}" alt="{{siteName}}" style="height: {{logoHeight}};">
    </div>
    <nav>
      {{#each menuItems}}
      <a href="{{this.link}}" style="margin-left: 30px; color: {{../linkColor}}; text-decoration: none; font-weight: 500;">{{this.label}}</a>
      {{/each}}
    </nav>
  </div>
</header>',
'{"siteName": "My Store", "logoUrl": "/assets/logo.png", "logoHeight": "40px", "backgroundColor": "#ffffff", "linkColor": "#333333", "menuItems": [{"label": "Home", "link": "/"}, {"label": "Products", "link": "/products"}, {"label": "About", "link": "/about"}, {"label": "Contact", "link": "/contact"}]}',
'{"type": "object"}'),

('footer', 'layout', 'layout-list', '<footer style="background: {{backgroundColor}}; color: {{textColor}}; padding: 60px 20px; margin-top: 80px;">
  <div style="max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px;">
    <div>
      <h3 style="margin-bottom: 1rem;">About</h3>
      <p style="line-height: 1.6;">{{aboutText}}</p>
    </div>
    <div>
      <h3 style="margin-bottom: 1rem;">Quick Links</h3>
      {{#each links}}
      <p><a href="{{this.url}}" style="color: {{../linkColor}}; text-decoration: none;">{{this.text}}</a></p>
      {{/each}}
    </div>
    <div>
      <h3 style="margin-bottom: 1rem;">Contact</h3>
      <p>{{contactEmail}}</p>
      <p>{{contactPhone}}</p>
    </div>
  </div>
  <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.1);">
    <p>© {{year}} {{companyName}}. All rights reserved.</p>
  </div>
</footer>',
'{"backgroundColor": "#1a202c", "textColor": "#ffffff", "linkColor": "#667eea", "aboutText": "We are committed to providing the best products and service.", "contactEmail": "hello@example.com", "contactPhone": "+1 234 567 890", "companyName": "My Store", "links": [{"text": "Privacy Policy", "url": "/privacy"}, {"text": "Terms of Service", "url": "/terms"}]}',
'{"type": "object"}')

ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- ASSETS TABLE - Store uploaded images/videos
-- ============================================================
CREATE TABLE IF NOT EXISTS assets (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  mime_type VARCHAR(100),
  size_bytes INTEGER,
  storage_path TEXT NOT NULL, -- S3 key or local file path
  public_url TEXT, -- CDN URL if using S3
  alt_text VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX idx_assets_tenant ON assets(tenant_id);
CREATE INDEX idx_assets_created_at ON assets(created_at DESC);

-- ============================================================
-- PAGE_VERSIONS TABLE - Track page history (optional but useful)
-- ============================================================
CREATE TABLE IF NOT EXISTS page_versions (
  id SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  blocks JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id),
  UNIQUE(page_id, version_number)
);

CREATE INDEX idx_page_versions_page ON page_versions(page_id);

COMMENT ON TABLE themes IS 'Store theme configurations per tenant';
COMMENT ON TABLE pages IS 'Pages with JSON-based block configurations (Shopify-style visual editor)';
COMMENT ON TABLE block_types IS 'Available block types for the page builder';
COMMENT ON TABLE assets IS 'Uploaded media files (images, videos, documents)';
COMMENT ON TABLE page_versions IS 'Version history for pages (rollback support)';
