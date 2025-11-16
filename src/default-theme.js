/**
 * Default Theme Setup
 * Creates default theme and pages for new tenants
 */

export async function createDefaultTheme(db, tenantId) {
  try {
    // Create default theme
    const themeResult = await db.query(
      `INSERT INTO themes (tenant_id, name, is_active, settings) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id`,
      [
        tenantId,
        'Default Theme',
        true,
        {
          colors: {
            primary: '#667eea',
            secondary: '#764ba2',
            text: '#333333',
            background: '#ffffff'
          },
          fonts: {
            heading: 'Inter, sans-serif',
            body: 'Inter, sans-serif'
          },
          layout: {
            maxWidth: '1200px'
          }
        }
      ]
    );
    
    const themeId = themeResult.rows[0].id;
    
    // Create default pages
    const pages = [
      {
        slug: 'home',
        title: 'Home',
        seo_description: 'Welcome to our store',
        blocks: [
          {
            type: 'header',
            config: {
              siteName: 'My Store',
              logoUrl: '/assets/logo.png',
              logoHeight: '40px',
              backgroundColor: '#ffffff',
              linkColor: '#333333',
              menuItems: [
                { label: 'Home', link: '/' },
                { label: 'Products', link: '/products' },
                { label: 'About', link: '/about' },
                { label: 'Contact', link: '/contact' }
              ]
            }
          },
          {
            type: 'hero',
            config: {
              title: 'Welcome to Our Store',
              subtitle: 'Discover amazing products crafted with love',
              backgroundImage: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1600',
              height: '600px',
              textColor: '#ffffff',
              buttonText: 'Shop Now',
              buttonLink: '/products',
              buttonColor: '#667eea'
            }
          },
          {
            type: 'product-grid',
            config: {
              columns: '3',
              limit: '6',
              showPrice: true,
              showAddToCart: true
            }
          },
          {
            type: 'call-to-action',
            config: {
              title: 'Ready to Get Started?',
              description: 'Join thousands of happy customers',
              buttonText: 'Shop Now',
              buttonLink: '/products',
              backgroundColor: '#667eea',
              textColor: '#ffffff',
              buttonColor: '#ffffff'
            }
          },
          {
            type: 'footer',
            config: {
              backgroundColor: '#1a202c',
              textColor: '#ffffff',
              linkColor: '#667eea',
              aboutText: 'We are committed to providing the best products and excellent customer service.',
              contactEmail: 'hello@example.com',
              contactPhone: '+1 234 567 890',
              companyName: 'My Store',
              links: [
                { text: 'Privacy Policy', url: '/privacy' },
                { text: 'Terms of Service', url: '/terms' },
                { text: 'Shipping Policy', url: '/shipping' }
              ]
            }
          }
        ]
      },
      {
        slug: 'about',
        title: 'About Us',
        seo_description: 'Learn more about our company',
        blocks: [
          {
            type: 'header',
            config: {
              siteName: 'My Store',
              logoUrl: '/assets/logo.png',
              logoHeight: '40px',
              backgroundColor: '#ffffff',
              linkColor: '#333333',
              menuItems: [
                { label: 'Home', link: '/' },
                { label: 'Products', link: '/products' },
                { label: 'About', link: '/about' },
                { label: 'Contact', link: '/contact' }
              ]
            }
          },
          {
            type: 'hero',
            config: {
              title: 'About Our Company',
              subtitle: 'Our story, mission, and values',
              backgroundImage: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=1600',
              height: '400px',
              textColor: '#ffffff',
              buttonText: '',
              buttonLink: '',
              buttonColor: '#667eea'
            }
          },
          {
            type: 'section-two-column',
            config: {
              title: 'Our Story',
              description: 'Founded in 2024, we started with a simple mission: to provide high-quality products that make life better. Today, we serve thousands of happy customers worldwide.',
              leftImage: 'https://images.unsplash.com/photo-1556761175-b413da4baf72?w=800',
              leftImageAlt: 'Our team'
            }
          },
          {
            type: 'text',
            config: {
              heading: 'Our Mission',
              content: '<p>We believe in creating products that are not only beautiful but also functional and sustainable. Our team works tirelessly to source the best materials and craft each product with attention to detail.</p><p>Customer satisfaction is at the heart of everything we do. We listen to your feedback and continuously improve our products and services.</p>',
              maxWidth: '800px',
              headingSize: '2rem',
              headingColor: '#333',
              textSize: '1.1rem',
              textColor: '#666'
            }
          },
          {
            type: 'footer',
            config: {
              backgroundColor: '#1a202c',
              textColor: '#ffffff',
              linkColor: '#667eea',
              aboutText: 'We are committed to providing the best products and excellent customer service.',
              contactEmail: 'hello@example.com',
              contactPhone: '+1 234 567 890',
              companyName: 'My Store',
              links: [
                { text: 'Privacy Policy', url: '/privacy' },
                { text: 'Terms of Service', url: '/terms' }
              ]
            }
          }
        ]
      },
      {
        slug: 'contact',
        title: 'Contact Us',
        seo_description: 'Get in touch with us',
        blocks: [
          {
            type: 'header',
            config: {
              siteName: 'My Store',
              logoUrl: '/assets/logo.png',
              logoHeight: '40px',
              backgroundColor: '#ffffff',
              linkColor: '#333333',
              menuItems: [
                { label: 'Home', link: '/' },
                { label: 'Products', link: '/products' },
                { label: 'About', link: '/about' },
                { label: 'Contact', link: '/contact' }
              ]
            }
          },
          {
            type: 'hero',
            config: {
              title: 'Get In Touch',
              subtitle: 'We\'d love to hear from you',
              backgroundImage: 'https://images.unsplash.com/photo-1423666639041-f56000c27a9a?w=1600',
              height: '400px',
              textColor: '#ffffff',
              buttonText: '',
              buttonLink: '',
              buttonColor: '#667eea'
            }
          },
          {
            type: 'text',
            config: {
              heading: 'Contact Information',
              content: '<p><strong>Email:</strong> hello@example.com</p><p><strong>Phone:</strong> +1 234 567 890</p><p><strong>Address:</strong> 123 Main Street, City, Country</p><p><strong>Business Hours:</strong> Monday - Friday, 9:00 AM - 6:00 PM</p>',
              maxWidth: '800px',
              headingSize: '2rem',
              headingColor: '#333',
              textSize: '1.1rem',
              textColor: '#666'
            }
          },
          {
            type: 'footer',
            config: {
              backgroundColor: '#1a202c',
              textColor: '#ffffff',
              linkColor: '#667eea',
              aboutText: 'We are committed to providing the best products and excellent customer service.',
              contactEmail: 'hello@example.com',
              contactPhone: '+1 234 567 890',
              companyName: 'My Store',
              links: [
                { text: 'Privacy Policy', url: '/privacy' },
                { text: 'Terms of Service', url: '/terms' }
              ]
            }
          }
        ]
      }
    ];
    
    // Insert pages
    for (const page of pages) {
      await db.query(
        `INSERT INTO pages (tenant_id, theme_id, slug, title, seo_description, content, is_published)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [tenantId, themeId, page.slug, page.title, page.seo_description, JSON.stringify(page.blocks)]
      );
    }
    
    console.log(`✅ Default theme and pages created for tenant ${tenantId}`);
    return themeId;
    
  } catch (error) {
    console.error('Error creating default theme:', error);
    throw error;
  }
}
