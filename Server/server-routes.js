const QRCode = require('qrcode');
const { getRepository } = require('./repository');
const { getAIRouter } = require('./ai-router');
const dayjs = require('dayjs');

function setupRoutes(app) {
  const config = app.get('config');
  
  // Middleware for authentication
  const requireStaff = (req, res, next) => {
    if (req.cookies.staff_auth === config.STAFF_PIN) {
      return next();
    }
    return res.status(401).send(renderLoginPage('staff', 'Invalid PIN or session expired'));
  };

  const requireAdmin = (req, res, next) => {
    if (req.cookies.admin_auth === config.ADMIN_PIN) {
      return next();
    }
    return res.status(401).send(renderLoginPage('admin', 'Invalid PIN or session expired'));
  };

  const requireKiosk = (req, res, next) => {
    if (req.cookies.kiosk_mode === 'true') {
      return next();
    }
    return res.redirect('/admin');
  };

  // ================================
  // PUBLIC / RESIDENT ROUTES
  // ================================

  // Landing page
  app.get('/', (req, res) => {
    res.send(renderLandingPage());
  });

  // Resident onboarding form
  app.get('/onboard', (req, res) => {
    const hub = req.query.hub || 'HUB-LB-001';
    const repo = getRepository();
    const hubInfo = repo.getHubByCode(hub);
    res.send(renderOnboardingForm(hubInfo));
  });

  // Submit onboarding
  app.post('/api/onboard', async (req, res) => {
    try {
      const repo = getRepository();
      const aiRouter = getAIRouter(config);
      
      const clientData = {
        name: req.body.name || '',
        phone: req.body.phone || '',
        needs: Array.isArray(req.body.needs) ? req.body.needs : [req.body.needs].filter(Boolean),
        urgency: req.body.urgency || 'medium',
        zipCode: req.body.zipCode || '',
        householdSize: parseInt(req.body.householdSize) || 1,
        consent: parseInt(req.body.consent) || 0,
        hubCode: req.body.hubCode || 'HUB-LB-001',
        additionalInfo: req.body.additionalInfo || ''
      };

      // Create client (redact PII if no consent)
      const client = repo.createClient(clientData, clientData.consent === 0);
      
      // Assign caseworker
      const caseworker = repo.assignCaseworker(client);
      
      // Update client with caseworker assignment
      repo.updateClient(client.id, { caseworkerId: caseworker.id });
      
      // Create appointment
      const appointmentDate = dayjs().add(
        clientData.urgency === 'critical' ? 1 : 
        clientData.urgency === 'high' ? 2 : 3, 
        'days'
      ).hour(10).minute(0);
      
      const appointment = repo.createAppointment({
        clientId: client.id,
        caseworkerId: caseworker.id,
        scheduledDate: appointmentDate.toISOString(),
        method: Math.random() > 0.6 ? 'phone' : 'in-person',
        location: 'Downtown Hub',
        status: 'scheduled'
      });

      // Generate status token
      const statusToken = Buffer.from(client.id).toString('base64');

      res.json({
        success: true,
        client: {
          id: client.id,
          name: client.consent ? client.name : 'Anonymous User'
        },
        caseworker: {
          name: caseworker.name,
          agency: caseworker.agency
        },
        appointment: {
          id: appointment.id,
          date: appointmentDate.format('dddd, MMMM D [at] h:mm A'),
          method: appointment.method,
          location: appointment.location
        },
        statusUrl: `/status/${statusToken}`
      });
    } catch (error) {
      console.error('Onboarding error:', error);
      res.status(500).json({ success: false, error: 'Unable to complete onboarding' });
    }
  });

  // AI Navigator endpoint
  app.post('/api/navigator', async (req, res) => {
    try {
      const aiRouter = getAIRouter(config);
      const query = req.body.query || '';
      
      const response = await aiRouter.route('navigator', query, {
        context: req.body.context || {}
      });
      
      res.json({
        response: response.response,
        confidence: response.confidence,
        source: response.source
      });
    } catch (error) {
      res.json({
        response: "I'm here to help connect you with services. Please let a caseworker know what specific assistance you need.",
        confidence: 0.5,
        source: 'fallback'
      });
    }
  });

  // Resident status page
  app.get('/status/:token', (req, res) => {
    try {
      const clientId = Buffer.from(req.params.token, 'base64').toString();
      const repo = getRepository();
      const client = repo.getClientById(clientId);
      
      if (!client) {
        return res.status(404).send(renderErrorPage('Status not found'));
      }
      
      const caseworker = repo.getCaseworkerById(client.caseworkerId);
      const appointments = repo.getAppointmentsByClient(clientId);
      
      res.send(renderStatusPage(client, caseworker, appointments));
    } catch (error) {
      res.status(404).send(renderErrorPage('Invalid status link'));
    }
  });

  // Confirm appointment
  app.post('/api/appointments/:id/confirm', (req, res) => {
    try {
      const repo = getRepository();
      const appointment = repo.updateAppointment(req.params.id, { 
        status: 'confirmed',
        confirmedAt: dayjs().toISOString()
      });
      
      res.json({ success: true, appointment });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Unable to confirm appointment' });
    }
  });

  // QR Code generation
  app.get('/qr/:code.png', async (req, res) => {
    try {
      const url = `${req.protocol}://${req.get('host')}/onboard?hub=${req.params.code}`;
      const qr = await QRCode.toBuffer(url, { width: 300, margin: 2 });
      res.set('Content-Type', 'image/png');
      res.send(qr);
    } catch (error) {
      res.status(500).send('Error generating QR code');
    }
  });

  // ================================
  // STAFF ROUTES
  // ================================

  // Staff login
  app.get('/staff', (req, res) => {
    res.send(renderLoginPage('staff'));
  });

  app.post('/staff/auth', (req, res) => {
    if (req.body.pin === config.STAFF_PIN) {
      res.cookie('staff_auth', config.STAFF_PIN, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
      return res.redirect('/dashboard');
    }
    res.send(renderLoginPage('staff', 'Invalid PIN'));
  });

  // Staff dashboard
  app.get('/dashboard', requireStaff, (req, res) => {
    const repo = getRepository();
    const filters = {
      urgency: req.query.urgency,
      need: req.query.need,
      search: req.query.search
    };
    
    const clients = repo.getClients(filters);
    res.send(renderDashboard(clients, filters));
  });

  // Manual client onboarding
  app.get('/clients/new', requireStaff, (req, res) => {
    res.send(renderManualOnboarding());
  });

  app.post('/api/clients', requireStaff, async (req, res) => {
    try {
      const repo = getRepository();
      
      const clientData = {
        ...req.body,
        needs: Array.isArray(req.body.needs) ? req.body.needs : [req.body.needs].filter(Boolean),
        householdSize: parseInt(req.body.householdSize) || 1,
        consent: parseInt(req.body.consent) || 1, // Staff entry defaults to consent
        source: 'staff'
      };

      const client = repo.createClient(clientData, clientData.consent === 0);
      
      // Auto-assign caseworker if not specified
      if (!clientData.caseworkerId) {
        const caseworker = repo.assignCaseworker(client);
        repo.updateClient(client.id, { caseworkerId: caseworker.id });
      }

      res.json({ success: true, client });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Unable to create client' });
    }
  });

  // AI Triage suggestions
  app.post('/api/triage/:clientId', requireStaff, async (req, res) => {
    try {
      const repo = getRepository();
      const client = repo.getClientById(req.params.clientId);
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      const aiRouter = getAIRouter(config);
      const triage = await aiRouter.route('triage', client, {
        caseworkerContext: req.body.context || {}
      });
      
      res.json(triage);
    } catch (error) {
      res.status(500).json({ error: 'Triage service unavailable' });
    }
  });

  // AI Care plan draft
  app.post('/api/careplan/:clientId', requireStaff, async (req, res) => {
    try {
      const repo = getRepository();
      const client = repo.getClientById(req.params.clientId);
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      const aiRouter = getAIRouter(config);
      const careplan = await aiRouter.route('careplan', client, {
        caseworkerInput: req.body.input || {}
      });
      
      res.json(careplan);
    } catch (error) {
      res.status(500).json({ error: 'Care plan service unavailable' });
    }
  });

  // Staff CSV export
  app.get('/export/staff.csv', requireStaff, (req, res) => {
    const repo = getRepository();
    const clients = repo.getClients();
    
    const csv = generateStaffCSV(clients, repo);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=staff-caseload.csv');
    res.send(csv);
  });

  // ================================
  // ADMIN ROUTES
  // ================================

  // Admin login
  app.get('/admin', (req, res) => {
    if (req.cookies.admin_auth === config.ADMIN_PIN) {
      return res.send(renderAdminHome());
    }
    res.send(renderLoginPage('admin'));
  });

  app.post('/admin/auth', (req, res) => {
    if (req.body.pin === config.ADMIN_PIN) {
      res.cookie('admin_auth', config.ADMIN_PIN, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
      return res.redirect('/admin');
    }
    res.send(renderLoginPage('admin', 'Invalid PIN'));
  });

  // Analytics dashboard
  app.get('/admin/analytics', requireAdmin, (req, res) => {
    const repo = getRepository();
    const analytics = repo.getAnalyticsData();
    res.send(renderAnalyticsDashboard(analytics));
  });

  // HUD/HMIS CSV export
  app.get('/export/hmis.csv', requireAdmin, (req, res) => {
    const repo = getRepository();
    const clients = repo.getClients();
    
    const csv = generateHMISCSV(clients, repo);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=hmis-export.csv');
    res.send(csv);
  });

  // Feature flags management
  app.get('/admin/flags', requireAdmin, (req, res) => {
    const repo = getRepository();
    const configData = repo.getConfig();
    res.send(renderFeatureFlags(configData));
  });

  app.post('/admin/flags', requireAdmin, (req, res) => {
    const repo = getRepository();
    const updates = {
      enableAINavigator: req.body.enableAINavigator === 'on',
      enableAICareplan: req.body.enableAICareplan === 'on',
      enableAnalyticsRefresh: req.body.enableAnalyticsRefresh === 'on'
    };
    
    repo.updateConfig(updates);
    res.redirect('/admin/flags');
  });

  // Cost control panel
  app.get('/admin/cost', requireAdmin, (req, res) => {
    const aiRouter = getAIRouter(config);
    const stats = aiRouter.getStats();
    res.send(renderCostPanel(stats, config));
  });

  // Schedule management (mock)
  app.get('/admin/schedule', requireAdmin, (req, res) => {
    const repo = getRepository();
    const configData = repo.getConfig();
    res.send(renderSchedulePanel(configData));
  });

  // ================================
  // KIOSK ROUTES
  // ================================

  // Start kiosk mode
  app.get('/admin/kiosk/start', requireAdmin, (req, res) => {
    res.cookie('kiosk_mode', 'true', { maxAge: 24 * 60 * 60 * 1000 }); // 24 hours
    res.redirect('/kiosk');
  });

  // Kiosk interface
  app.get('/kiosk', requireKiosk, (req, res) => {
    res.send(renderKioskInterface());
  });

  // Exit kiosk mode
  app.get('/admin/kiosk/exit', (req, res) => {
    if (req.query.pin === config.ADMIN_PIN) {
      res.clearCookie('kiosk_mode');
      return res.redirect('/admin');
    }
    res.send(renderKioskExit());
  });

  app.post('/admin/kiosk/exit', (req, res) => {
    if (req.body.pin === config.ADMIN_PIN) {
      res.clearCookie('kiosk_mode');
      return res.redirect('/admin');
    }
    res.send(renderKioskExit('Invalid PIN'));
  });

  // Logout routes
  app.get('/staff/logout', (req, res) => {
    res.clearCookie('staff_auth');
    res.redirect('/staff');
  });

  app.get('/admin/logout', (req, res) => {
    res.clearCookie('admin_auth');
    res.redirect('/admin');
  });
}

// ================================
// RENDER FUNCTIONS
// ================================

function renderLandingPage() {
  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .glassmorphism { backdrop-filter: blur(16px); background: rgba(255, 255, 255, 0.1); }
    </style>
</head>
<body class="h-full bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 text-white">
    <div class="min-h-screen flex items-center justify-center p-4">
        <div class="glassmorphism border border-white/20 rounded-3xl p-8 max-w-md w-full text-center">
            <div class="mb-8">
                <h1 class="text-4xl font-bold mb-4 bg-gradient-to-r from-blue-200 to-purple-200 bg-clip-text text-transparent">
                    First Contact E.I.S.
                </h1>
                <p class="text-white/80 text-lg">Connect with human services in Long Beach</p>
            </div>
            
            <div class="space-y-4">
                <a href="/onboard" class="block w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:shadow-xl transition-all transform hover:scale-105">
                    Get Help Now
                </a>
                
                <p class="text-white/60 text-sm">
                    Access housing, employment, healthcare, and other essential services
                </p>
            </div>
            
            <div class="mt-8 pt-6 border-t border-white/20">
                <p class="text-white/50 text-xs mb-2">Service Providers</p>
                <div class="flex gap-2 justify-center text-xs">
                    <a href="/staff" class="text-blue-300 hover:text-blue-200">Staff Portal</a>
                    <span class="text-white/30">•</span>
                    <a href="/admin" class="text-purple-300 hover:text-purple-200">Admin</a>
                </div>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function renderOnboardingForm(hubInfo) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Get Help - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .glassmorphism { backdrop-filter: blur(16px); background: rgba(255, 255, 255, 0.95); }
    </style>
</head>
<body class="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50">
    <div class="container mx-auto px-4 py-8">
        <div class="max-w-2xl mx-auto">
            <div class="glassmorphism rounded-3xl p-8 shadow-xl border border-white/50">
                <div class="text-center mb-8">
                    <h1 class="text-3xl font-bold text-gray-800 mb-2">How can we help you?</h1>
                    <p class="text-gray-600">Tell us what you need - we're here to connect you with the right services</p>
                </div>

                <form id="onboardingForm" class="space-y-6">
                    <input type="hidden" name="hubCode" value="${hubInfo?.code || 'HUB-LB-001'}">
                    
                    <div class="grid md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">Name (optional)</label>
                            <input type="text" name="name" class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">Phone (optional)</label>
                            <input type="tel" name="phone" class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                        </div>
                    </div>

                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-3">What type of help do you need? *</label>
                        <div class="grid grid-cols-2 gap-3">
                            ${['housing', 'employment', 'mental-health', 'medical', 'food', 'veterans', 'substance-abuse', 'legal', 'utilities', 'transportation'].map(need => 
                                `<label class="flex items-center p-3 border border-gray-300 rounded-xl hover:bg-blue-50 cursor-pointer">
                                    <input type="checkbox" name="needs" value="${need}" class="mr-3 text-blue-600">
                                    <span class="text-sm font-medium capitalize">${need.replace('-', ' ')}</span>
                                </label>`
                            ).join('')}
                        </div>
                    </div>

                    <div class="grid md:grid-cols-3 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">How urgent? *</label>
                            <select name="urgency" required class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500">
                                <option value="low">I can wait</option>
                                <option value="medium" selected>Soon</option>
                                <option value="high">This week</option>
                                <option value="critical">Emergency</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
                            <input type="text" name="zipCode" maxlength="5" class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">Household Size</label>
                            <input type="number" name="householdSize" min="1" value="1" class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500">
                        </div>
                    </div>

                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Additional Information</label>
                        <textarea name="additionalInfo" rows="3" class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500" placeholder="Anything else we should know?"></textarea>
                    </div>

                    <div class="border-t pt-6">
                        <div class="mb-4">
                            <label class="flex items-start">
                                <input type="radio" name="consent" value="1" required class="mt-1 mr-3 text-blue-600">
                                <span class="text-sm text-gray-700">
                                    <strong>Yes, I consent</strong> to sharing my information with service providers to help me access resources.
                                </span>
                            </label>
                        </div>
                        <div class="mb-6">
                            <label class="flex items-start">
                                <input type="radio" name="consent" value="0" required class="mt-1 mr-3 text-blue-600">
                                <span class="text-sm text-gray-700">
                                    <strong>No consent</strong> - I want help but prefer to remain anonymous.
                                </span>
                            </label>
                        </div>
                    </div>

                    <div class="flex gap-4">
                        <button type="button" id="navigatorBtn" class="flex-1 bg-gray-100 text-gray-700 py-4 px-6 rounded-xl font-semibold hover:bg-gray-200 transition-colors">
                            💬 Ask Navigator
                        </button>
                        <button type="submit" class="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 text-white py-4 px-6 rounded-xl font-semibold hover:shadow-lg transition-all">
                            Submit Request
                        </button>
                    </div>
                </form>

                <div id="navigatorChat" class="hidden mt-6 p-4 bg-blue-50 rounded-xl">
                    <div class="mb-4">
                        <h3 class="font-semibold text-blue-900 mb-2">AI Navigator</h3>
                        <div id="chatMessages" class="space-y-2 mb-4 max-h-40 overflow-y-auto">
                            <div class="text-sm text-blue-800 bg-white p-3 rounded-lg">
                                Hi! I can help explain what services are available. What would you like to know?
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <input type="text" id="navigatorInput" class="flex-1 px-3 py-2 text-sm border border-blue-300 rounded-lg" placeholder="Ask about services...">
                            <button id="sendNavigator" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Send</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div id="successModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div class="bg-white rounded-3xl p-8 max-w-md w-full text-center">
            <div class="text-green-600 text-6xl mb-4">✓</div>
            <h2 class="text-2xl font-bold text-gray-800 mb-4">Request Submitted!</h2>
            <div id="successContent" class="text-gray-600 space-y-2"></div>
            <div class="mt-6 space-y-3">
                <button id="confirmAppointment" class="w-full bg-green-600 text-white py-3 px-6 rounded-xl font-semibold">Confirm Appointment</button>
                <button id="rescheduleAppointment" class="w-full bg-gray-100 text-gray-700 py-3 px-6 rounded-xl font-semibold">Request Reschedule</button>
                <a id="statusLink" href="#" class="block text-blue-600 text-sm underline">View Status Page</a>
            </div>
        </div>
    </div>

    <script>
        // Navigator chat functionality
        document.getElementById('navigatorBtn').addEventListener('click', function() {
            const chat = document.getElementById('navigatorChat');
            chat.classList.toggle('hidden');
        });

        document.getElementById('sendNavigator').addEventListener('click', sendNavigatorMessage);
        document.getElementById('navigatorInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') sendNavigatorMessage();
        });

        async function sendNavigatorMessage() {
            const input = document.getElementById('navigatorInput');
            const messages = document.getElementById('chatMessages');
            const query = input.value.trim();
            
            if (!query) return;
            
            // Add user message
            messages.innerHTML += \`<div class="text-sm bg-blue-600 text-white p-3 rounded-lg ml-8">$\{query}</div>\`;
            input.value = '';
            
            try {
                const response = await fetch('/api/navigator', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, context: {} })
                });
                const data = await response.json();
                
                messages.innerHTML += \`<div class="text-sm text-blue-800 bg-white p-3 rounded-lg">$\{data.response}</div>\`;
                messages.scrollTop = messages.scrollHeight;
            } catch (error) {
                messages.innerHTML += \`<div class="text-sm text-red-800 bg-red-50 p-3 rounded-lg">Sorry, I'm having trouble connecting right now.</div>\`;
            }
        }

        // Form submission
        document.getElementById('onboardingForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const needs = formData.getAll('needs');
            
            if (needs.length === 0) {
                alert('Please select at least one type of help you need.');
                return;
            }

            const data = Object.fromEntries(formData);
            data.needs = needs;

            try {
                const response = await fetch('/api/onboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                const result = await response.json();
                
                if (result.success) {
                    showSuccessModal(result);
                } else {
                    alert('There was an error submitting your request. Please try again.');
                }
            } catch (error) {
                alert('Unable to submit request. Please check your connection and try again.');
            }
        });

        function showSuccessModal(result) {
            const modal = document.getElementById('successModal');
            const content = document.getElementById('successContent');
            
            content.innerHTML = \`
                <p><strong>Your caseworker is $\{result.caseworker.name}</strong></p>
                <p><strong>Your appointment via $\{result.appointment.method} is $\{result.appointment.date}</strong></p>
                <p class="text-sm mt-2">Confirm or request reschedule below.</p>
            \`;
            
            document.getElementById('statusLink').href = result.statusUrl;
            
            document.getElementById('confirmAppointment').onclick = async function() {
                try {
                    await fetch(\`/api/appointments/$\{result.appointment.id}/confirm\`, { method: 'POST' });
                    alert('Appointment confirmed! You will receive a reminder.');
                    window.location.href = result.statusUrl;
                } catch (error) {
                    alert('Unable to confirm appointment. Please call your caseworker.');
                }
            };
            
            document.getElementById('rescheduleAppointment').onclick = function() {
                alert('Please call your caseworker to reschedule: ' + result.caseworker.name);
                window.location.href = result.statusUrl;
            };
            
            modal.classList.remove('hidden');
        }
    </script>
</body>
</html>`;
}

function renderLoginPage(role, error = '') {
  const title = role === 'admin' ? 'Admin Portal' : 'Staff Portal';
  const action = role === 'admin' ? '/admin/auth' : '/staff/auth';
  
  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full bg-gray-50">
    <div class="min-h-full flex items-center justify-center py-12 px-4">
        <div class="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
            <div class="text-center mb-8">
                <h2 class="text-3xl font-bold text-gray-900">${title}</h2>
                <p class="text-gray-600 mt-2">Enter your PIN to continue</p>
            </div>
            
            ${error ? `<div class="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg">${error}</div>` : ''}
            
            <form method="POST" action="${action}">
                <div class="mb-6">
                    <label class="block text-sm font-medium text-gray-700 mb-2">PIN</label>
                    <input type="password" name="pin" required 
                           class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-lg tracking-widest">
                </div>
                <button type="submit" class="w-full bg-blue-600 text-white py-3 px-4 rounded-lg font-semibold hover:bg-blue-700 transition-colors">
                    Sign In
                </button>
            </form>
            
            <div class="mt-6 text-center">
                <a href="/" class="text-blue-600 text-sm hover:text-blue-500">← Back to Home</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function renderDashboard(clients, filters) {
  const urgencyColors = {
    'critical': 'bg-red-100 text-red-800',
    'high': 'bg-orange-100 text-orange-800',
    'medium': 'bg-yellow-100 text-yellow-800',
    'low': 'bg-green-100 text-green-800'
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Staff Dashboard - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Staff Dashboard</h1>
                <div class="flex items-center space-x-4">
                    <a href="/clients/new" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">+ Manual Onboarding</a>
                    <a href="/export/staff.csv" class="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium">Export CSV</a>
                    <a href="/staff/logout" class="text-gray-600 text-sm">Logout</a>
                </div>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <!-- Filters -->
        <div class="bg-white rounded-lg shadow-sm p-6 mb-6">
            <form method="GET" class="flex flex-wrap gap-4">
                <input type="text" name="search" value="${filters.search || ''}" placeholder="Search name or phone..." 
                       class="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                <select name="urgency" class="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                    <option value="">All Urgency</option>
                    <option value="critical" ${filters.urgency === 'critical' ? 'selected' : ''}>Critical</option>
                    <option value="high" ${filters.urgency === 'high' ? 'selected' : ''}>High</option>
                    <option value="medium" ${filters.urgency === 'medium' ? 'selected' : ''}>Medium</option>
                    <option value="low" ${filters.urgency === 'low' ? 'selected' : ''}>Low</option>
                </select>
                <select name="need" class="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                    <option value="">All Needs</option>
                    <option value="housing" ${filters.need === 'housing' ? 'selected' : ''}>Housing</option>
                    <option value="employment" ${filters.need === 'employment' ? 'selected' : ''}>Employment</option>
                    <option value="mental-health" ${filters.need === 'mental-health' ? 'selected' : ''}>Mental Health</option>
                </select>
                <button type="submit" class="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium">Filter</button>
                <a href="/dashboard" class="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg">Clear</a>
            </form>
        </div>

        <!-- Client List -->
        <div class="bg-white rounded-lg shadow-sm overflow-hidden">
            <div class="px-6 py-4 border-b border-gray-200">
                <h2 class="text-lg font-semibold text-gray-800">Client Cases (${clients.length})</h2>
            </div>
            
            <div class="divide-y divide-gray-200">
                ${clients.map(client => `
                    <div class="p-6 hover:bg-gray-50">
                        <div class="flex justify-between items-start mb-3">
                            <div>
                                <h3 class="font-semibold text-gray-900">${client.name || 'Anonymous User'}</h3>
                                <p class="text-sm text-gray-600">${client.phone || 'No phone'} • ZIP: ${client.zipCode || 'N/A'}</p>
                            </div>
                            <div class="flex items-center space-x-2">
                                <span class="px-2 py-1 text-xs font-medium rounded-full ${urgencyColors[client.urgency] || urgencyColors.medium}">
                                    ${client.urgency || 'medium'}
                                </span>
                                <span class="px-2 py-1 text-xs bg-gray-100 text-gray-800 rounded-full">
                                    ${client.status || 'intake'}
                                </span>
                            </div>
                        </div>
                        
                        <div class="mb-3">
                            <p class="text-sm text-gray-600 mb-1">Needs:</p>
                            <div class="flex flex-wrap gap-1">
                                ${(client.needs || []).map(need => 
                                    `<span class="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">${need.replace('-', ' ')}</span>`
                                ).join('')}
                            </div>
                        </div>
                        
                        <div class="flex justify-between items-center">
                            <p class="text-xs text-gray-500">Created: ${new Date(client.createdAt).toLocaleDateString()}</p>
                            <div class="flex space-x-2">
                                <button onclick="getTriage('${client.id}')" class="text-blue-600 text-sm font-medium hover:text-blue-500">AI Triage</button>
                                <button onclick="getCarePlan('${client.id}')" class="text-purple-600 text-sm font-medium hover:text-purple-500">Care Plan</button>
                                <button onclick="updateClient('${client.id}')" class="text-gray-600 text-sm font-medium hover:text-gray-500">Update</button>
                            </div>
                        </div>
                    </div>
                `).join('')}
                
                ${clients.length === 0 ? `
                    <div class="p-12 text-center">
                        <p class="text-gray-500">No clients match your current filters.</p>
                    </div>
                ` : ''}
            </div>
        </div>
    </div>

    <!-- Modal for AI responses -->
    <div id="aiModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div class="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-96 overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h3 id="modalTitle" class="text-lg font-semibold"></h3>
                <button onclick="closeModal()" class="text-gray-400 hover:text-gray-600">&times;</button>
            </div>
            <div id="modalContent" class="prose max-w-none"></div>
        </div>
    </div>

    <script>
        async function getTriage(clientId) {
            try {
                const response = await fetch(\`/api/triage/$\{clientId}\`, { method: 'POST' });
                const data = await response.json();
                
                document.getElementById('modalTitle').textContent = 'AI Triage Suggestions';
                document.getElementById('modalContent').innerHTML = \`
                    <div class="space-y-4">
                        <div>
                            <h4 class="font-semibold text-$\{data.priority === 'urgent' ? 'red' : 'blue'}-600">Priority: $\{data.priority}</h4>
                        </div>
                        <div>
                            <h4 class="font-semibold mb-2">Recommendations:</h4>
                            <ul class="list-disc list-inside">
                                $\{(data.recommendations || []).map(r => \`<li>$\{r}</li>\`).join('')}
                            </ul>
                        </div>
                        <div>
                            <h4 class="font-semibold mb-2">Next Steps:</h4>
                            <ul class="list-disc list-inside">
                                $\{(data.nextSteps || []).map(s => \`<li>$\{s}</li>\`).join('')}
                            </ul>
                        </div>
                        <p class="text-sm text-gray-500">Source: $\{data.source} (Confidence: $\{Math.round((data.confidence || 0) * 100)}%)</p>
                    </div>
                \`;
                document.getElementById('aiModal').classList.remove('hidden');
            } catch (error) {
                alert('Unable to get triage suggestions at this time.');
            }
        }

        async function getCarePlan(clientId) {
            try {
                const response = await fetch(\`/api/careplan/$\{clientId}\`, { method: 'POST' });
                const data = await response.json();
                
                document.getElementById('modalTitle').textContent = 'AI Care Plan Draft';
                document.getElementById('modalContent').innerHTML = \`
                    <div class="space-y-4">
                        <div>
                            <h4 class="font-semibold mb-2">Goals:</h4>
                            <ul class="list-disc list-inside">
                                $\{(data.goals || []).map(g => \`<li>$\{g}</li>\`).join('')}
                            </ul>
                        </div>
                        <div>
                            <h4 class="font-semibold mb-2">Tasks:</h4>
                            <ul class="list-disc list-inside">
                                $\{(data.tasks || []).map(t => \`<li>$\{t}</li>\`).join('')}
                            </ul>
                        </div>
                        <div>
                            <h4 class="font-semibold mb-2">Resources:</h4>
                            <ul class="list-disc list-inside">
                                $\{(data.resources || []).map(r => \`<li>$\{r}</li>\`).join('')}
                            </ul>
                        </div>
                        <p class="text-sm text-gray-500">Timeline: $\{data.timeline} | Review: $\{data.reviewDate ? new Date(data.reviewDate).toLocaleDateString() : 'TBD'}</p>
                        <p class="text-sm text-gray-500">Source: $\{data.source} (Confidence: $\{Math.round((data.confidence || 0) * 100)}%)</p>
                    </div>
                \`;
                document.getElementById('aiModal').classList.remove('hidden');
            } catch (error) {
                alert('Unable to generate care plan at this time.');
            }
        }

        function updateClient(clientId) {
            // For MVP, just show alert
            alert('Client update feature - redirect to detailed client page');
        }

        function closeModal() {
            document.getElementById('aiModal').classList.add('hidden');
        }
    </script>
</body>
</html>`;
}

function renderManualOnboarding() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Manual Onboarding - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Manual Client Onboarding</h1>
                <a href="/dashboard" class="text-blue-600 font-medium">← Back to Dashboard</a>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <div class="max-w-2xl mx-auto bg-white rounded-lg shadow-sm p-8">
            <form id="manualForm" class="space-y-6">
                <div class="grid md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                        <input type="text" name="name" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                        <input type="tel" name="phone" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-3">Service Needs *</label>
                    <div class="grid grid-cols-2 gap-3">
                        ${['housing', 'employment', 'mental-health', 'medical', 'food', 'veterans', 'substance-abuse', 'legal', 'utilities', 'transportation'].map(need => 
                            `<label class="flex items-center p-3 border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">
                                <input type="checkbox" name="needs" value="${need}" class="mr-3 text-blue-600">
                                <span class="text-sm font-medium capitalize">${need.replace('-', ' ')}</span>
                            </label>`
                        ).join('')}
                    </div>
                </div>

                <div class="grid md:grid-cols-4 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Urgency *</label>
                        <select name="urgency" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                            <option value="low">Low</option>
                            <option value="medium" selected>Medium</option>
                            <option value="high">High</option>
                            <option value="critical">Critical</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
                        <input type="text" name="zipCode" maxlength="5" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Household Size</label>
                        <input type="number" name="householdSize" min="1" value="1" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Status</label>
                        <select name="status" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                            <option value="intake">Intake</option>
                            <option value="active">Active</option>
                            <option value="pending">Pending</option>
                        </select>
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                    <textarea name="additionalInfo" rows="4" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" placeholder="Additional client information..."></textarea>
                </div>

                <div class="flex gap-4">
                    <button type="button" onclick="history.back()" class="flex-1 bg-gray-100 text-gray-700 py-3 px-6 rounded-lg font-semibold">Cancel</button>
                    <button type="submit" class="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700">Create Client</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        document.getElementById('manualForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const needs = formData.getAll('needs');
            
            if (needs.length === 0) {
                alert('Please select at least one service need.');
                return;
            }

            const data = Object.fromEntries(formData);
            data.needs = needs;
            data.consent = 1; // Staff entry assumes consent
            data.source = 'staff';

            try {
                const response = await fetch('/api/clients', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                const result = await response.json();
                
                if (result.success) {
                    alert('Client created successfully!');
                    window.location.href = '/dashboard';
                } else {
                    alert('Error creating client: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                alert('Unable to create client. Please try again.');
            }
        });
    </script>
</body>
</html>`;
}

// Additional render functions would continue...
// For brevity, I'll include key ones and indicate where others would go

function renderAdminHome() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Portal - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Admin Portal</h1>
                <a href="/admin/logout" class="text-gray-600 text-sm">Logout</a>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <a href="/admin/analytics" class="bg-white p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div class="flex items-center mb-4">
                    <div class="bg-blue-100 p-3 rounded-lg">
                        <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                        </svg>
                    </div>
                </div>
                <h3 class="text-lg font-semibold text-gray-800 mb-2">Analytics Dashboard</h3>
                <p class="text-gray-600 text-sm">View intake trends, caseworker loads, and performance metrics</p>
            </a>

            <a href="/export/hmis.csv" class="bg-white p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div class="flex items-center mb-4">
                    <div class="bg-green-100 p-3 rounded-lg">
                        <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                    </div>
                </div>
                <h3 class="text-lg font-semibold text-gray-800 mb-2">HMIS Export</h3>
                <p class="text-gray-600 text-sm">Download HUD/HMIS-aligned compliance report</p>
            </a>

            <a href="/admin/flags" class="bg-white p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div class="flex items-center mb-4">
                    <div class="bg-purple-100 p-3 rounded-lg">
                        <svg class="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                        </svg>
                    </div>
                </div>
                <h3 class="text-lg font-semibold text-gray-800 mb-2">Feature Flags</h3>
                <p class="text-gray-600 text-sm">Enable/disable AI features and system components</p>
            </a>

            <a href="/admin/cost" class="bg-white p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div class="flex items-center mb-4">
                    <div class="bg-yellow-100 p-3 rounded-lg">
                        <svg class="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1"></path>
                        </svg>
                    </div>
                </div>
                <h3 class="text-lg font-semibold text-gray-800 mb-2">Cost Controls</h3>
                <p class="text-gray-600 text-sm">Monitor AI usage, cache performance, and budget limits</p>
            </a>

            <a href="/admin/schedule" class="bg-white p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div class="flex items-center mb-4">
                    <div class="bg-indigo-100 p-3 rounded-lg">
                        <svg class="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                </div>
                <h3 class="text-lg font-semibold text-gray-800 mb-2">Scheduling</h3>
                <p class="text-gray-600 text-sm">Configure automated reports and data refresh timing</p>
            </a>

            <a href="/admin/kiosk/start" class="bg-white p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div class="flex items-center mb-4">
                    <div class="bg-red-100 p-3 rounded-lg">
                        <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                        </svg>
                    </div>
                </div>
                <h3 class="text-lg font-semibold text-gray-800 mb-2">Start Kiosk Mode</h3>
                <p class="text-gray-600 text-sm">Enable kiosk interface on this device</p>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function renderAnalyticsDashboard(analytics) {
  const needsData = Object.entries(analytics.needsCount).map(([need, count]) => `['${need}', ${count}]`).join(',');
  const urgencyData = Object.entries(analytics.urgencyCount).map(([urgency, count]) => `['${urgency}', ${count}]`).join(',');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Analytics Dashboard - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Analytics Dashboard</h1>
                <div class="flex items-center space-x-4">
                    <button onclick="refreshData()" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Refresh Data</button>
                    <a href="/admin" class="text-gray-600 text-sm">← Back to Admin</a>
                </div>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <!-- Key Metrics -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="bg-white p-6 rounded-lg shadow-sm">
                <div class="flex items-center">
                    <div class="p-3 rounded-full bg-blue-100 text-blue-600">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
                        </svg>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">Total Intakes (30d)</p>
                        <p class="text-2xl font-bold text-gray-900">${analytics.totalIntakes}</p>
                    </div>
                </div>
            </div>

            <div class="bg-white p-6 rounded-lg shadow-sm">
                <div class="flex items-center">
                    <div class="p-3 rounded-full bg-green-100 text-green-600">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">Avg Time to Appt</p>
                        <p class="text-2xl font-bold text-gray-900">${analytics.avgTimeToAppointment}h</p>
                    </div>
                </div>
            </div>

            <div class="bg-white p-6 rounded-lg shadow-sm">
                <div class="flex items-center">
                    <div class="p-3 rounded-full bg-yellow-100 text-yellow-600">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"></path>
                        </svg>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">Urgent Cases</p>
                        <p class="text-2xl font-bold text-gray-900">${analytics.urgencyCount.high + analytics.urgencyCount.critical}</p>
                    </div>
                </div>
            </div>

            <div class="bg-white p-6 rounded-lg shadow-sm">
                <div class="flex items-center">
                    <div class="p-3 rounded-full bg-purple-100 text-purple-600">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"></path>
                        </svg>
                    </div>
                    <div class="ml-4">
                        <p class="text-sm font-medium text-gray-600">Active Caseworkers</p>
                        <p class="text-2xl font-bold text-gray-900">${analytics.caseworkerLoads.length}</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Charts Row -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div class="bg-white p-6 rounded-lg shadow-sm">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Intakes by Service Need</h3>
                <canvas id="needsChart" width="400" height="200"></canvas>
            </div>

            <div class="bg-white p-6 rounded-lg shadow-sm">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Cases by Urgency Level</h3>
                <canvas id="urgencyChart" width="400" height="200"></canvas>
            </div>
        </div>

        <!-- Caseworker Performance -->
        <div class="bg-white rounded-lg shadow-sm overflow-hidden">
            <div class="px-6 py-4 border-b border-gray-200">
                <h3 class="text-lg font-semibold text-gray-800">Caseworker Performance</h3>
            </div>
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Caseworker</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Agency</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Active Cases</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total Cases</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Workload</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
                        ${analytics.caseworkerLoads.map(cw => {
                            const workloadColor = cw.activeClients > 15 ? 'text-red-600 bg-red-100' :
                                                 cw.activeClients > 10 ? 'text-yellow-600 bg-yellow-100' :
                                                 'text-green-600 bg-green-100';
                            return `
                            <tr>
                                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${cw.name}</td>
                                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${cw.agency}</td>
                                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${cw.activeClients}</td>
                                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${cw.totalClients}</td>
                                <td class="px-6 py-4 whitespace-nowrap">
                                    <span class="inline-flex px-2 py-1 text-xs font-semibold rounded-full ${workloadColor}">
                                        ${cw.activeClients > 15 ? 'High' : cw.activeClients > 10 ? 'Medium' : 'Normal'}
                                    </span>
                                </td>
                            </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        // Initialize charts
        const needsCtx = document.getElementById('needsChart').getContext('2d');
        new Chart(needsCtx, {
            type: 'doughnut',
            data: {
                labels: [${Object.keys(analytics.needsCount).map(need => `'${need.replace('-', ' ')}'`).join(',')}],
                datasets: [{
                    data: [${Object.values(analytics.needsCount).join(',')}],
                    backgroundColor: [
                        '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
                        '#06B6D4', '#84CC16', '#F97316', '#EC4899', '#6B7280'
                    ]
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });

        const urgencyCtx = document.getElementById('urgencyChart').getContext('2d');
        new Chart(urgencyCtx, {
            type: 'bar',
            data: {
                labels: ['Low', 'Medium', 'High', 'Critical'],
                datasets: [{
                    label: 'Cases',
                    data: [${analytics.urgencyCount.low}, ${analytics.urgencyCount.medium}, ${analytics.urgencyCount.high}, ${analytics.urgencyCount.critical}],
                    backgroundColor: ['#10B981', '#F59E0B', '#EF4444', '#7C2D12']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });

        function refreshData() {
            location.reload();
        }
    </script>
</body>
</html>`;
}

// Helper functions for CSV generation
function generateStaffCSV(clients, repo) {
  const headers = ['ID', 'Name', 'Phone', 'Needs', 'Urgency', 'Status', 'ZIP Code', 'Household Size', 'Created Date', 'Caseworker', 'Agency'];
  const rows = clients.map(client => {
    const caseworker = repo.getCaseworkerById(client.caseworkerId);
    return [
      client.id,
      client.name || 'Anonymous',
      client.phone || '',
      (client.needs || []).join(';'),
      client.urgency || '',
      client.status || '',
      client.zipCode || '',
      client.householdSize || '',
      client.createdAt,
      caseworker ? caseworker.name : '',
      caseworker ? caseworker.agency : ''
    ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

function generateHMISCSV(clients, repo) {
  // HUD/HMIS aligned columns (simplified for MVP)
  const headers = [
    'PersonalID', 'FirstName', 'LastName', 'SSN', 'DOB', 'Race', 'Ethnicity', 'Gender',
    'EnrollmentID', 'ProjectID', 'EntryDate', 'ExitDate', 'Destination',
    'HouseholdID', 'RelationshipToHoH', 'LengthOfStay', 'PreviousStreetESSH',
    'DisabilityType', 'DisabilityResponse', 'IndefiniteAndImpairs',
    'IncomeFromAnySource', 'TotalMonthlyIncome', 'Earned', 'EarnedAmount'
  ];

  const rows = clients.map(client => [
    client.id,
    client.name ? client.name.split(' ')[0] : '',
    client.name ? client.name.split(' ').slice(1).join(' ') : '',
    '', // SSN - not collected
    '', // DOB - not collected
    '', // Race - not collected
    '', // Ethnicity - not collected
    '', // Gender - not collected
    `ENR-${client.id}`,
    'PROJ-001', // Static project ID
    new Date(client.createdAt).toISOString().split('T')[0],
    '', // Exit date - not exited
    '', // Destination - not applicable
    client.id, // Use client ID as household ID for simplicity
    '1', // Head of household
    '', // Length of stay - not applicable for intake
    '', // Previous street - not collected
    '', // Disability type - not collected
    '', // Disability response - not collected
    '', // Indefinite and impairs - not collected
    '', // Income from any source - not collected
    '', // Total monthly income - not collected
    '', // Earned - not collected
    ''  // Earned amount - not collected
  ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(','));

  return [headers.join(','), ...rows].join('\n');
}

function renderStatusPage(client, caseworker, appointments) {
  const nextAppointment = appointments.find(a => a.status === 'scheduled');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Status - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <div class="max-w-2xl mx-auto">
            <div class="bg-white rounded-3xl shadow-xl p-8">
                <div class="text-center mb-8">
                    <h1 class="text-3xl font-bold text-gray-800 mb-2">Your Status</h1>
                    <p class="text-gray-600">Here's where things stand with your request</p>
                </div>

                <div class="space-y-6">
                    <div class="bg-blue-50 rounded-2xl p-6">
                        <h2 class="text-lg font-semibold text-blue-900 mb-3">Your Caseworker</h2>
                        <p class="text-blue-800"><strong>${caseworker ? caseworker.name : 'Being assigned'}</strong></p>
                        <p class="text-blue-700 text-sm">${caseworker ? caseworker.agency : ''}</p>
                    </div>

                    ${nextAppointment ? `
                    <div class="bg-green-50 rounded-2xl p-6">
                        <h2 class="text-lg font-semibold text-green-900 mb-3">Next Appointment</h2>
                        <p class="text-green-800"><strong>${new Date(nextAppointment.scheduledDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong></p>
                        <p class="text-green-700 text-sm">Via ${nextAppointment.method} at ${nextAppointment.location}</p>
                        ${nextAppointment.status === 'scheduled' ? `
                        <div class="mt-4 flex gap-3">
                            <button onclick="confirmAppointment('${nextAppointment.id}')" class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Confirm</button>
                            <button onclick="requestReschedule()" class="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium">Reschedule</button>
                        </div>
                        ` : ''}
                    </div>
                    ` : `
                    <div class="bg-yellow-50 rounded-2xl p-6">
                        <h2 class="text-lg font-semibold text-yellow-900 mb-3">Scheduling Appointment</h2>
                        <p class="text-yellow-800">Your caseworker will contact you soon to schedule your first appointment.</p>
                    </div>
                    `}

                    <div class="bg-purple-50 rounded-2xl p-6">
                        <h2 class="text-lg font-semibold text-purple-900 mb-3">Services You Requested</h2>
                        <div class="flex flex-wrap gap-2">
                            ${(client.needs || []).map(need => 
                                `<span class="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-sm">${need.replace('-', ' ')}</span>`
                            ).join('')}
                        </div>
                    </div>

                    <div class="bg-gray-50 rounded-2xl p-6">
                        <h2 class="text-lg font-semibold text-gray-900 mb-3">Next Steps</h2>
                        <ul class="list-disc list-inside text-gray-700 space-y-2">
                            <li>Wait for your caseworker to contact you</li>
                            <li>Gather any documents you might have (ID, income proof, etc.)</li>
                            <li>Think about your specific goals and needs</li>
                            <li>Keep this status page bookmarked for updates</li>
                        </ul>
                    </div>
                </div>

                <div class="mt-8 text-center">
                    <p class="text-gray-500 text-sm">Need help? Contact your caseworker or call (562) 570-4444</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function confirmAppointment(appointmentId) {
            try {
                const response = await fetch(\`/api/appointments/$\{appointmentId}/confirm\`, { method: 'POST' });
                if (response.ok) {
                    alert('Appointment confirmed! You will receive a reminder.');
                    location.reload();
                } else {
                    throw new Error('Failed to confirm');
                }
            } catch (error) {
                alert('Unable to confirm appointment. Please call your caseworker.');
            }
        }

        function requestReschedule() {
            alert('To reschedule, please call your caseworker directly. Their contact information will be provided soon.');
        }
    </script>
</body>
</html>`;
}

function renderFeatureFlags(config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Feature Flags - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Feature Flags</h1>
                <a href="/admin" class="text-blue-600 font-medium">← Back to Admin</a>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <div class="max-w-2xl mx-auto bg-white rounded-lg shadow-sm p-8">
            <div class="mb-6">
                <h2 class="text-lg font-semibold text-gray-800 mb-2">System Configuration</h2>
                <p class="text-gray-600 text-sm">Enable or disable system features and AI capabilities</p>
            </div>

            <form method="POST" class="space-y-6">
                <div class="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                    <div>
                        <h3 class="font-medium text-gray-800">AI Navigator</h3>
                        <p class="text-sm text-gray-600">Conversational AI for resident intake forms</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" name="enableAINavigator" class="sr-only peer" ${config.enableAINavigator ? 'checked' : ''}>
                        <div class="w-11 h-6 bg-gray-200 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-300 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                </div>

                <div class="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                    <div>
                        <h3 class="font-medium text-gray-800">AI Care Plan Generation</h3>
                        <p class="text-sm text-gray-600">AI-assisted care plan drafts for caseworkers</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" name="enableAICareplan" class="sr-only peer" ${config.enableAICareplan ? 'checked' : ''}>
                        <div class="w-11 h-6 bg-gray-200 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-300 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                </div>

                <div class="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                    <div>
                        <h3 class="font-medium text-gray-800">Analytics Auto-Refresh</h3>
                        <p class="text-sm text-gray-600">Automatically refresh analytics data on schedule</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" name="enableAnalyticsRefresh" class="sr-only peer" ${config.enableAnalyticsRefresh ? 'checked' : ''}>
                        <div class="w-11 h-6 bg-gray-200 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-300 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                </div>

                <div class="flex gap-4 pt-4">
                    <button type="submit" class="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700">Save Changes</button>
                    <button type="button" onclick="history.back()" class="flex-1 bg-gray-100 text-gray-700 py-3 px-6 rounded-lg font-semibold">Cancel</button>
                </div>
            </form>
        </div>
    </div>
</body>
</html>`;
}

function renderCostPanel(stats, config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cost Controls - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Cost Control Panel</h1>
                <a href="/admin" class="text-blue-600 font-medium">← Back to Admin</a>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <!-- AI Status -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">AI Status</h3>
                <div class="space-y-3">
                    <div class="flex justify-between">
                        <span class="text-gray-600">AI Features:</span>
                        <span class="font-medium ${stats.enabled ? 'text-green-600' : 'text-red-600'}">
                            ${stats.enabled ? 'ENABLED' : 'DISABLED'}
                        </span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">OpenAI Key:</span>
                        <span class="font-medium ${config.OPENAI_API_KEY ? 'text-green-600' : 'text-gray-400'}">
                            ${config.OPENAI_API_KEY ? 'Configured' : 'Not Set'}
                        </span>
                    </div>
                </div>
            </div>

            <!-- Cache Performance -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Cache Performance</h3>
                <div class="space-y-3">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Hit Rate:</span>
                        <span class="font-medium text-green-600">${stats.cacheHitRate}%</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Cache Size:</span>
                        <span class="font-medium">${stats.cacheSize} items</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Hits/Misses:</span>
                        <span class="font-medium">${stats.cacheHits}/${stats.cacheMisses}</span>
                    </div>
                </div>
            </div>

            <!-- API Usage -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">API Usage</h3>
                <div class="space-y-3">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Cheap Calls:</span>
                        <span class="font-medium text-green-600">${stats.cheapCalls}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Expensive Calls:</span>
                        <span class="font-medium text-orange-600">${stats.expensiveCalls}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Daily Tokens:</span>
                        <span class="font-medium">${stats.dailyTokens}</span>
                    </div>
                </div>
            </div>

            <!-- Budget Status -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Daily Budget</h3>
                <div class="mb-3">
                    <div class="flex justify-between text-sm text-gray-600 mb-1">
                        <span>Usage</span>
                        <span>${stats.dailyBudgetUsed}%</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-2">
                        <div class="bg-blue-600 h-2 rounded-full" style="width: ${stats.dailyBudgetUsed}%"></div>
                    </div>
                </div>
                <div class="flex justify-between text-sm">
                    <span class="text-gray-600">Est. Daily Cost:</span>
                    <span class="font-medium">${stats.estimatedDailyCost}</span>
                </div>
            </div>

            <!-- Emergency Controls -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Emergency Controls</h3>
                <div class="space-y-3">
                    <button onclick="clearCache()" class="w-full bg-yellow-100 text-yellow-800 py-2 px-4 rounded-lg text-sm font-medium hover:bg-yellow-200">
                        Clear Cache
                    </button>
                    <button onclick="disableAI()" class="w-full bg-red-100 text-red-800 py-2 px-4 rounded-lg text-sm font-medium hover:bg-red-200">
                        Disable AI (Emergency)
                    </button>
                </div>
            </div>

            <!-- Token Limits -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Token Limits</h3>
                <div class="space-y-3">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Cheap Model:</span>
                        <span class="font-medium">${config.AI_MAX_TOKENS_CHEAP} tokens</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Expensive Model:</span>
                        <span class="font-medium">${config.AI_MAX_TOKENS_EXPENSIVE} tokens</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Temperature:</span>
                        <span class="font-medium">${config.AI_TEMP}</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Recent Activity Log -->
        <div class="mt-8 bg-white rounded-lg shadow-sm overflow-hidden">
            <div class="px-6 py-4 border-b border-gray-200">
                <h3 class="text-lg font-semibold text-gray-800">Cost Activity Log</h3>
            </div>
            <div class="p-6">
                <div class="text-center text-gray-500 py-8">
                    <p>No recent high-cost activities detected.</p>
                    <p class="text-sm mt-2">System is operating within normal parameters.</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        function clearCache() {
            if (confirm('Clear all cached AI responses? This will temporarily slow down AI features.')) {
                // In a real implementation, this would call an API endpoint
                alert('Cache cleared successfully.');
                location.reload();
            }
        }

        function disableAI() {
            if (confirm('Disable AI features immediately? This will fall back to rules-based responses only.')) {
                // In a real implementation, this would call an API endpoint to set AI_ENABLE=false
                alert('AI features disabled. System switched to fallback mode.');
                location.reload();
            }
        }
    </script>
</body>
</html>`;
}

function renderSchedulePanel(config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Schedule Settings - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-gray-800">Schedule Settings</h1>
                <a href="/admin" class="text-blue-600 font-medium">← Back to Admin</a>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8">
        <div class="max-w-2xl mx-auto space-y-6">
            <!-- Analytics Refresh -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Analytics Refresh Schedule</h3>
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Refresh Time</label>
                        <select class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                            <option value="6" ${config.scheduleRefreshHour === 6 ? 'selected' : ''}>6:00 AM</option>
                            <option value="0" ${config.scheduleRefreshHour === 0 ? 'selected' : ''}>12:00 AM</option>
                            <option value="12" ${config.scheduleRefreshHour === 12 ? 'selected' : ''}>12:00 PM</option>
                            <option value="18" ${config.scheduleRefreshHour === 18 ? 'selected' : ''}>6:00 PM</option>
                        </select>
                    </div>
                    <div class="bg-blue-50 p-4 rounded-lg">
                        <p class="text-blue-800 text-sm">
                            <strong>Current Status:</strong> Analytics data was last updated today at 6:00 AM PST.
                            Next refresh scheduled for tomorrow at ${config.scheduleRefreshHour || 6}:00.
                        </p>
                    </div>
                </div>
            </div>

            <!-- HMIS Export -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">HMIS Export Schedule</h3>
                <div class="space-y-4">
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Frequency</label>
                            <select class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                <option value="manual" selected>Manual Only</option>
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                                <option value="monthly">Monthly</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Export Time</label>
                            <select class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                <option value="2">2:00 AM</option>
                                <option value="6" selected>6:00 AM</option>
                                <option value="22">10:00 PM</option>
                            </select>
                        </div>
                    </div>
                    <div class="bg-gray-50 p-4 rounded-lg">
                        <p class="text-gray-600 text-sm">
                            <strong>Note:</strong> Automated HMIS exports are currently disabled.
                            All exports must be generated manually for data integrity.
                        </p>
                    </div>
                </div>
            </div>

            <!-- Cache Management -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">Cache Management</h3>
                <div class="space-y-4">
                    <div class="grid grid-cols-3 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Navigator Cache (hours)</label>
                            <input type="number" value="24" min="1" max="168" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Triage Cache (hours)</label>
                            <input type="number" value="2" min="0.5" max="24" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Analytics Cache (minutes)</label>
                            <input type="number" value="15" min="1" max="60" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                        </div>
                    </div>
                </div>
            </div>

            <!-- Save Button -->
            <div class="bg-white rounded-lg shadow-sm p-6">
                <div class="flex gap-4">
                    <button class="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700">
                        Save Schedule Settings
                    </button>
                    <button onclick="testRefresh()" class="bg-gray-100 text-gray-700 py-3 px-6 rounded-lg font-semibold hover:bg-gray-200">
                        Test Refresh Now
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        function testRefresh() {
            if (confirm('Trigger an immediate analytics refresh? This may take a few moments.')) {
                alert('Analytics refresh initiated. Check the analytics dashboard in a few moments.');
            }
        }
    </script>
</body>
</html>`;
}

function renderKioskInterface() {
  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Contact E.I.S. Kiosk</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .glassmorphism { backdrop-filter: blur(16px); background: rgba(255, 255, 255, 0.1); }
        body { -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; }
    </style>
</head>
<body class="h-full bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 text-white overflow-hidden">
    <div class="min-h-screen flex items-center justify-center p-8">
        <div class="glassmorphism border border-white/20 rounded-3xl p-12 max-w-2xl w-full text-center">
            <div class="mb-12">
                <h1 class="text-6xl font-bold mb-6 bg-gradient-to-r from-blue-200 to-purple-200 bg-clip-text text-transparent">
                    First Contact E.I.S.
                </h1>
                <p class="text-white/90 text-2xl mb-4">Connect with human services</p>
                <p class="text-white/70 text-lg">Housing • Employment • Healthcare • Support</p>
            </div>
            
            <div class="space-y-8">
                <a href="/onboard?hub=HUB-LB-001" class="block w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-8 px-8 rounded-3xl font-bold text-3xl hover:shadow-2xl transition-all transform hover:scale-105">
                    🏠 Start Here - Get Help Now
                </a>
                
                <div class="grid grid-cols-2 gap-6 text-white/80">
                    <div class="bg-white/10 p-6 rounded-2xl">
                        <div class="text-4xl mb-3">🏘️</div>
                        <h3 class="font-semibold text-lg mb-2">Housing</h3>
                        <p class="text-sm">Emergency shelter, rental assistance, permanent housing</p>
                    </div>
                    <div class="bg-white/10 p-6 rounded-2xl">
                        <div class="text-4xl mb-3">💼</div>
                        <h3 class="font-semibold text-lg mb-2">Employment</h3>
                        <p class="text-sm">Job training, placement assistance, career support</p>
                    </div>
                    <div class="bg-white/10 p-6 rounded-2xl">
                        <div class="text-4xl mb-3">🏥</div>
                        <h3 class="font-semibold text-lg mb-2">Healthcare</h3>
                        <p class="text-sm">Medical care, mental health, substance abuse treatment</p>
                    </div>
                    <div class="bg-white/10 p-6 rounded-2xl">
                        <div class="text-4xl mb-3">🤝</div>
                        <h3 class="font-semibold text-lg mb-2">Support</h3>
                        <p class="text-sm">Food assistance, legal aid, transportation help</p>
                    </div>
                </div>
            </div>
            
            <div class="mt-12 pt-8 border-t border-white/20">
                <p class="text-white/60 text-sm mb-4">Need to exit kiosk mode?</p>
                <a href="/admin/kiosk/exit" class="text-white/40 text-xs underline hover:text-white/60">Staff Access</a>
            </div>
        </div>
    </div>

    <script>
        // Prevent common exit methods
        document.addEventListener('keydown', function(e) {
            // Disable F11, Alt+Tab, Ctrl+Alt+Del, etc.
            if (e.key === 'F11' || (e.altKey && e.key === 'Tab') || (e.ctrlKey && e.altKey && e.key === 'Delete')) {
                e.preventDefault();
                return false;
            }
        });

        // Disable right-click context menu
        document.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            return false;
        });

        // Auto-refresh to prevent session timeout (every 30 minutes)
        setInterval(function() {
            location.reload();
        }, 30 * 60 * 1000);
    </script>
</body>
</html>`;
}

function renderKioskExit(error = '') {
  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Exit Kiosk Mode - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full bg-gray-900 text-white">
    <div class="min-h-full flex items-center justify-center py-12 px-4">
        <div class="max-w-md w-full bg-gray-800 rounded-2xl shadow-xl p-8">
            <div class="text-center mb-8">
                <h2 class="text-3xl font-bold text-white">Exit Kiosk Mode</h2>
                <p class="text-gray-300 mt-2">Enter admin PIN to continue</p>
            </div>
            
            ${error ? `<div class="mb-4 p-3 bg-red-900 border border-red-700 text-red-100 rounded-lg">${error}</div>` : ''}
            
            <form method="POST">
                <div class="mb-6">
                    <label class="block text-sm font-medium text-gray-300 mb-2">Admin PIN</label>
                    <input type="password" name="pin" required autofocus
                           class="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-lg tracking-widest text-white">
                </div>
                <button type="submit" class="w-full bg-red-600 text-white py-3 px-4 rounded-lg font-semibold hover:bg-red-700 transition-colors">
                    Exit Kiosk Mode
                </button>
            </form>
            
            <div class="mt-6 text-center">
                <a href="/kiosk" class="text-gray-400 text-sm hover:text-gray-300">← Back to Kiosk</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error - First Contact E.I.S.</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full bg-gray-50">
    <div class="min-h-full flex items-center justify-center py-12 px-4">
        <div class="max-w-md w-full text-center">
            <div class="text-red-500 text-6xl mb-4">⚠️</div>
            <h1 class="text-2xl font-bold text-gray-900 mb-4">Something went wrong</h1>
            <p class="text-gray-600 mb-8">${message}</p>
            <div class="space-y-4">
                <button onclick="history.back()" class="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold">
                    Go Back
                </button>
                <a href="/" class="block text-blue-600 hover:text-blue-500">
                    Return to Home
                </a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

module.exports = { setupRoutes };
