const crypto = require('crypto');

class CostGuard {
  constructor(config = {}) {
    this.cache = new Map();
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      cheapCalls: 0,
      expensiveCalls: 0,
      totalTokens: 0,
      dailyTokens: 0,
      lastResetDate: new Date().toDateString()
    };
    this.config = {
      maxDailyTokens: 10000,
      maxCheapTokens: config.AI_MAX_TOKENS_CHEAP || 256,
      maxExpensiveTokens: config.AI_MAX_TOKENS_EXPENSIVE || 512,
      defaultTTL: 3600, // 1 hour
      ...config
    };
  }

  // Create cache key from request input
  hashRequest(input, options = {}) {
    const normalized = typeof input === 'string' ? input : JSON.stringify(input);
    const optionsStr = JSON.stringify(options);
    return crypto.createHash('md5').update(normalized + optionsStr).digest('hex');
  }

  // Get from cache
  cacheGet(key) {
    const entry = this.cache.get(key);
    if (entry && entry.expiry > Date.now()) {
      this.stats.cacheHits++;
      return entry.data;
    }
    if (entry) {
      this.cache.delete(key); // Remove expired entry
    }
    this.stats.cacheMisses++;
    return null;
  }

  // Set cache with TTL
  cacheSet(key, data, ttlSeconds = null) {
    const ttl = ttlSeconds || this.config.defaultTTL;
    this.cache.set(key, {
      data,
      expiry: Date.now() + (ttl * 1000)
    });
  }

  // Check if we should escalate to expensive model
  shouldEscalate(result) {
    if (!result || typeof result !== 'object') return false;
    
    // Escalate if confidence is low
    if (result.confidence !== undefined && result.confidence < 0.7) {
      return true;
    }
    
    // Escalate if result indicates uncertainty
    if (result.uncertain || result.needsMoreContext) {
      return true;
    }
    
    return false;
  }

  // Reset daily counters if needed
  resetDailyCountersIfNeeded() {
    const today = new Date().toDateString();
    if (this.stats.lastResetDate !== today) {
      this.stats.dailyTokens = 0;
      this.stats.lastResetDate = today;
    }
  }

  // Check if we're within budget
  canMakeCall(tokenCount, type = 'cheap') {
    this.resetDailyCountersIfNeeded();
    
    if (this.stats.dailyTokens + tokenCount > this.config.maxDailyTokens) {
      return false;
    }
    
    const maxTokens = type === 'expensive' ? 
      this.config.maxExpensiveTokens : 
      this.config.maxCheapTokens;
      
    if (tokenCount > maxTokens) {
      return false;
    }
    
    return true;
  }

  // Execute function with budget tracking
  async withBudget(label, fn, estimatedTokens = 100, type = 'cheap') {
    if (!this.canMakeCall(estimatedTokens, type)) {
      throw new Error(`Budget exceeded for ${label}. Daily limit: ${this.config.maxDailyTokens}, used: ${this.stats.dailyTokens}`);
    }

    try {
      const result = await fn();
      
      // Track usage
      this.stats.totalTokens += estimatedTokens;
      this.stats.dailyTokens += estimatedTokens;
      
      if (type === 'expensive') {
        this.stats.expensiveCalls++;
      } else {
        this.stats.cheapCalls++;
      }
      
      return result;
    } catch (error) {
      console.error(`Cost-guarded call failed for ${label}:`, error.message);
      throw error;
    }
  }

  // Get current stats for admin dashboard
  getStats() {
    this.resetDailyCountersIfNeeded();
    
    const cacheTotal = this.stats.cacheHits + this.stats.cacheMisses;
    const cacheHitRate = cacheTotal > 0 ? (this.stats.cacheHits / cacheTotal * 100).toFixed(1) : '0.0';
    
    return {
      ...this.stats,
      cacheHitRate: parseFloat(cacheHitRate),
      cacheSize: this.cache.size,
      dailyBudgetUsed: ((this.stats.dailyTokens / this.config.maxDailyTokens) * 100).toFixed(1),
      estimatedDailyCost: (this.stats.dailyTokens * 0.0001).toFixed(4) // Rough estimate
    };
  }

  // Clear cache (admin function)
  clearCache() {
    this.cache.clear();
    return { cleared: true, newSize: this.cache.size };
  }

  // Set emergency budget limits
  setEmergencyLimits(limits) {
    this.config = { ...this.config, ...limits };
    return this.config;
  }
}

let costGuardInstance = null;

function getCostGuard(config = {}) {
  if (!costGuardInstance) {
    costGuardInstance = new CostGuard(config);
  }
  return costGuardInstance;
}

module.exports = { getCostGuard, CostGuard };
