// Feature Flag System for Progressive Rollouts
// This allows enabling features for specific tenants (canary testing)

export const FEATURE_FLAGS = {
  FLASH_SALE_BANNER: {
    enabled: true,
    tenants: [2], // Only tenant 2 (MTceelshop) gets this feature
    description: 'Show flash sale banner on merchant dashboard',
  },
  ADVANCED_ANALYTICS: {
    enabled: false,
    tenants: [], // Not enabled yet
    description: 'Advanced analytics dashboard with charts',
  },
  AI_PRODUCT_RECOMMENDATIONS: {
    enabled: false,
    tenants: [],
    description: 'AI-powered product recommendations',
  },
};

/**
 * Check if a feature is enabled for a specific tenant
 * @param {string} featureName - Name of the feature flag
 * @param {number} tenantId - Tenant ID to check
 * @returns {boolean}
 */
export function isFeatureEnabled(featureName, tenantId) {
  const feature = FEATURE_FLAGS[featureName];
  
  if (!feature || !feature.enabled) {
    return false;
  }
  
  // If tenants array is empty, feature is enabled for all
  if (feature.tenants.length === 0) {
    return true;
  }
  
  // Check if tenant is in the allowed list
  return feature.tenants.includes(tenantId);
}

/**
 * Get all enabled features for a tenant
 * @param {number} tenantId
 * @returns {string[]} Array of enabled feature names
 */
export function getEnabledFeatures(tenantId) {
  return Object.keys(FEATURE_FLAGS).filter(featureName =>
    isFeatureEnabled(featureName, tenantId)
  );
}
