const { getCostGuard } = require('./cost-guard');

class AIRouter {
  constructor(config = {}) {
    this.config = config;
    this.costGuard = getCostGuard(config);
    this.enabled = config.AI_ENABLE && config.OPENAI_API_KEY;
    
    // Pre-built rules and templates
    this.faqRules = {
      'housing': 'For housing assistance, you may qualify for rapid rehousing, emergency shelter, or rental assistance. Eligibility typically requires proof of homelessness or housing instability.',
      'employment': 'Employment services include job training, resume help, and placement assistance. Most programs are free and available regardless of work history.',
      'mental-health': 'Mental health services include counseling, crisis support, and medication assistance. Many services are available on a sliding scale.',
      'veterans': 'Veterans have access to specialized housing, healthcare, and employment programs through VA and community partners.',
      'substance-abuse': 'Substance abuse support includes outpatient counseling, residential treatment, and harm reduction services.',
      'medical': 'Medical services include free clinics, insurance enrollment, and specialty care referrals.',
      'food': 'Food assistance includes food banks, CalFresh (SNAP), and meal programs at community centers.',
      'legal': 'Legal aid includes help with housing court, benefits appeals, and family law matters.',
      'utilities': 'Utility assistance programs can help with past-due bills and ongoing payment support.',
      'transportation': 'Transportation help includes bus passes, rides to appointments, and vehicle repair assistance.'
    };
    
    this.triageRules = {
      'high-housing': 'Immediate housing placement or emergency shelter referral needed within 24-48 hours.',
      'high-medical': 'Schedule urgent medical appointment and assist with insurance enrollment.',
      'high-mental-health': 'Crisis assessment and immediate mental health referral required.',
      'medium-housing': 'Housing assessment and waitlist placement, follow up within 1 week.',
      'medium-employment': 'Job readiness assessment and skills training referral.',
      'low-general': 'Resource information and self-service options, follow up in 2 weeks.'
    };
    
    this.careplanTemplates = {
      'housing-focused': {
        goals: ['Secure stable housing within 90 days', 'Maintain housing stability'],
        tasks: ['Complete housing application', 'Gather required documents', 'Attend housing appointments'],
        resources: ['Rapid Rehousing Program', 'Housing Authority waitlist', 'Emergency rental assistance']
      },
      'employment-focused': {
        goals: ['Obtain sustainable employment', 'Increase job skills'],
        tasks: ['Update resume', 'Apply for job training', 'Attend job interviews'],
        resources: ['WorkForce Development', 'One-Stop Career Center', 'Skills training programs']
      },
      'health-focused': {
        goals: ['Establish primary care', 'Manage chronic conditions'],
        tasks: ['Schedule medical appointment', 'Apply for health insurance', 'Follow medication schedule'],
        resources: ['Community Health Center', 'Medi-Cal enrollment', 'Pharmacy assistance']
      }
    };
  }

  // Main routing function
  async route(task, input, options = {}) {
    const cacheKey = this.costGuard.hashRequest(`${task}:${input}`, options);
    const cached = this.costGuard.cacheGet(cacheKey);
    
    if (cached) {
      return cached;
    }

    let result;
    
    try {
      // Step 1: Try rules/lookup first (no API cost)
      result = await this.tryRulesFirst(task, input, options);
      
      // Step 2: If uncertain and AI enabled, try cheap model
      if (this.shouldEscalate(result) && this.enabled) {
        result = await this.tryCheapModel(task, input, options);
        
        // Step 3: If still uncertain, try expensive model
        if (this.shouldEscalate(result) && this.enabled) {
          result = await this.tryExpensiveModel(task, input, options);
        }
      }
      
      // Cache the result
      const ttl = this.getTTL(task);
      this.costGuard.cacheSet(cacheKey, result, ttl);
      
      return result;
      
    } catch (error) {
      console.error(`AI Router error for task ${task}:`, error.message);
      return this.getFallbackResponse(task, input, options);
    }
  }

  // Step 1: Rules-based responses (no API cost)
  async tryRulesFirst(task, input, options) {
    switch (task) {
      case 'navigator':
        return this.navigatorRules(input, options);
      
      case 'triage':
        return this.triageRules(input, options);
      
      case 'careplan':
        return this.careplanRules(input, options);
      
      default:
        return { uncertain: true, confidence: 0.3 };
    }
  }

  navigatorRules(input, options) {
    const query = input.toLowerCase();
    
    // Check for exact matches in FAQ
    for (const [category, response] of Object.entries(this.faqRules)) {
      if (query.includes(category) || query.includes(category.replace('-', ' '))) {
        return {
          response,
          confidence: 0.9,
          source: 'rules',
          category
        };
      }
    }
    
    // General greeting responses
    if (query.includes('help') || query.includes('hello') || query.includes('start')) {
      return {
        response: 'I can help you understand what services are available. What kind of help do you need? I can assist with housing, employment, healthcare, food, or other services.',
        confidence: 0.8,
        source: 'rules',
        category: 'general'
      };
    }
    
    // Indicate uncertainty for complex queries
    return {
      uncertain: true,
      confidence: 0.4,
      response: "I'd like to help you find the right resources. Could you tell me more specifically what kind of assistance you're looking for?"
    };
  }

  triageRules(client, options) {
    const needs = client.needs || [];
    const urgency = client.urgency || 'medium';
    const householdSize = client.householdSize || 1;
    
    // High urgency rules
    if (urgency === 'high' || urgency === 'critical') {
      if (needs.includes('housing')) {
        return {
          priority: 'urgent',
          recommendations: [
            'Emergency shelter placement needed within 24 hours',
            'Rapid rehousing assessment required',
            'Connect with housing navigator immediately'
          ],
          nextSteps: ['Schedule emergency housing meeting', 'Gather housing documents', 'Contact emergency shelter'],
          confidence: 0.95,
          source: 'rules'
        };
      }
      
      if (needs.includes('mental-health') || needs.includes('substance-abuse')) {
        return {
          priority: 'urgent',
          recommendations: [
            'Crisis assessment required',
            'Mental health evaluation needed',
            'Safety planning essential'
          ],
          nextSteps: ['Schedule crisis assessment', 'Provide crisis hotline numbers', 'Create safety plan'],
          confidence: 0.95,
          source: 'rules'
        };
      }
    }
    
    // Medium priority rules
    const recommendations = [];
    const nextSteps = [];
    
    needs.forEach(need => {
      switch (need) {
        case 'housing':
          recommendations.push('Housing assessment and application');
          nextSteps.push('Complete housing intake form');
          break;
        case 'employment':
          recommendations.push('Job readiness assessment');
          nextSteps.push('Schedule employment counseling');
          break;
        case 'medical':
          recommendations.push('Healthcare enrollment assistance');
          nextSteps.push('Schedule medical intake appointment');
          break;
      }
    });
    
    return {
      priority: urgency,
      recommendations,
      nextSteps,
      confidence: 0.8,
      source: 'rules'
    };
  }

  careplanRules(client, options) {
    const needs = client.needs || [];
    const primaryNeed = needs[0] || 'general';
    
    // Determine template based on primary need
    let template = this.careplanTemplates['housing-focused']; // default
    
    if (primaryNeed.includes('employment')) {
      template = this.careplanTemplates['employment-focused'];
    } else if (primaryNeed.includes('medical') || primaryNeed.includes('mental-health')) {
      template = this.careplanTemplates['health-focused'];
    }
    
    return {
      goals: template.goals.slice(),
      tasks: template.tasks.slice(),
      resources: template.resources.slice(),
      timeline: '90 days',
      reviewDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      confidence: 0.8,
      source: 'rules',
      customizable: true
    };
  }

  // Step 2: Cheap model (if enabled)
  async tryCheapModel(task, input, options) {
    if (!this.enabled) {
      return { uncertain: true, confidence: 0.3 };
    }

    return await this.costGuard.withBudget(
      `cheap-${task}`,
      async () => {
        // Mock API call for now - replace with actual OpenAI call
        await new Promise(resolve => setTimeout(resolve, 500)); // Simulate API delay
        
        return {
          response: `Enhanced response for ${task} (cheap model)`,
          confidence: 0.7,
          source: 'cheap-model',
          tokens: this.config.AI_MAX_TOKENS_CHEAP
        };
      },
      this.config.AI_MAX_TOKENS_CHEAP,
      'cheap'
    );
  }

  // Step 3: Expensive model (if needed)
  async tryExpensiveModel(task, input, options) {
    if (!this.enabled) {
      return { uncertain: true, confidence: 0.3 };
    }

    return await this.costGuard.withBudget(
      `expensive-${task}`,
      async () => {
        // Mock API call for now - replace with actual OpenAI call
        await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API delay
        
        return {
          response: `Detailed response for ${task} (expensive model)`,
          confidence: 0.95,
          source: 'expensive-model',
          tokens: this.config.AI_MAX_TOKENS_EXPENSIVE
        };
      },
      this.config.AI_MAX_TOKENS_EXPENSIVE,
      'expensive'
    );
  }

  // Check if we should escalate to next tier
  shouldEscalate(result) {
    if (!result) return true;
    return result.uncertain || result.confidence < 0.7;
  }

  // Get appropriate TTL for different tasks
  getTTL(task) {
    switch (task) {
      case 'navigator':
        return this.config.CACHE_TTL_FAQ || 86400; // 24 hours
      case 'triage':
        return this.config.CACHE_TTL_TRIAGE || 7200; // 2 hours
      case 'careplan':
        return this.config.CACHE_TTL_TRIAGE || 7200; // 2 hours
      default:
        return 3600; // 1 hour
    }
  }

  // Fallback response if everything fails
  getFallbackResponse(task, input, options) {
    switch (task) {
      case 'navigator':
        return {
          response: "I'm here to help connect you with services. Please let a caseworker know what specific assistance you need.",
          confidence: 0.5,
          source: 'fallback'
        };
      
      case 'triage':
        return {
          priority: 'medium',
          recommendations: ['General assessment needed', 'Schedule intake appointment'],
          nextSteps: ['Contact caseworker', 'Gather documentation'],
          confidence: 0.5,
          source: 'fallback'
        };
      
      case 'careplan':
        return {
          goals: ['Stabilize current situation', 'Connect with appropriate services'],
          tasks: ['Meet with caseworker', 'Complete assessments'],
          resources: ['Case management services', 'Community resources'],
          confidence: 0.5,
          source: 'fallback'
        };
      
      default:
        return {
          response: 'Service temporarily unavailable. Please contact your caseworker.',
          confidence: 0.3,
          source: 'fallback'
        };
    }
  }

  // Get stats for admin panel
  getStats() {
    return {
      enabled: this.enabled,
      ...this.costGuard.getStats()
    };
  }
}

let aiRouterInstance = null;

function getAIRouter(config = {}) {
  if (!aiRouterInstance) {
    aiRouterInstance = new AIRouter(config);
  }
  return aiRouterInstance;
}

module.exports = { getAIRouter, AIRouter };
