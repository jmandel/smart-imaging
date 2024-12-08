// oauth-imaging-server.js
import express from 'express';
import session from 'express-session';
import { MemoryStore } from 'express-session';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const app = express();

// Configure middleware
// Load configurations
const tenantConfig = new Map();
for (const f of fs.readdirSync('config')) {
    if (f.match(/\.json$/)) {
        tenantConfig.set(
            f.replace(/\.json$/, ''),
            JSON.parse(fs.readFileSync(path.resolve('config', f)))
        );
    }
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    store: new MemoryStore({ checkPeriod: 86400000 }), // Prune expired entries every 24h
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    name: 'imaging_session',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 3600000 // 1 hour
    }
}));

// Configuration middleware
app.use('/:configKey/*', async (req, res, next) => {
    let config;
    const { configKey } = req.params;

    if (configKey.startsWith('dyn_')) {
        // Dynamic configuration from base64url-encoded JSON
        try {
            const configData = Buffer.from(configKey.slice(4), 'base64url').toString();
            config = JSON.parse(configData);
        } catch (error) {
            return res.status(400).json({ error: 'Invalid dynamic configuration' });
        }
    } else {
        // Static configuration from config files
        config = tenantConfig.get(configKey);
        if (!config) {
            return res.status(404).json({ error: 'Configuration not found' });
        }
    }

    // Store config in request
    req.ehrContext = {
        baseUrl: `${req.protocol}://${req.get('host')}/${configKey}`,
        config: {
            clientId: config.authorization.client.client_id,
            fhirBaseUrl: config.authorization.fhirBaseUrl,
            scope: config.authorization.scope || 'openid fhirUser launch/patient patient/*.read'
        }
    };
    
    next();
});

// In-memory stores
const authorizationRequests = new Map();
const tokens = new Map();

// Helper to generate random bytes as base64url
function generateRandomString() {
    const buffer = crypto.randomBytes(32);
    return buffer.toString('base64url');
}

// Generate PKCE values
async function generatePkce() {
    const verifier = generateRandomString();
    const challenge = crypto.createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

// HTML template for authorization screen
function renderAuthorizationScreen(authRequest, ehrIdentity) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Authorize Imaging Access</title>
            <style>
                body {
                    font-family: system-ui, sans-serif;
                    max-width: 600px;
                    margin: 40px auto;
                    padding: 20px;
                    line-height: 1.5;
                }
                .container {
                    border: 1px solid #ccc;
                    border-radius: 8px;
                    padding: 20px;
                }
                .header {
                    margin-bottom: 20px;
                    padding-bottom: 20px;
                    border-bottom: 1px solid #eee;
                }
                .info {
                    margin: 20px 0;
                }
                .actions {
                    margin-top: 30px;
                    display: flex;
                    gap: 10px;
                }
                button {
                    padding: 10px 20px;
                    border-radius: 4px;
                    border: none;
                    cursor: pointer;
                }
                .approve {
                    background: #0066cc;
                    color: white;
                }
                .deny {
                    background: #f1f1f1;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h2>Authorize Access to Imaging Studies</h2>
                </div>
                
                <div class="info">
                    <p>The application <strong>${authRequest.client_id}</strong> is requesting access to imaging studies.</p>
                    <p>User: ${ehrIdentity.name || 'Unknown'}</p>
                    <p>Patient: ${ehrIdentity.patient || 'Unknown'}</p>
                </div>

                <form class="actions" action="./imaging-decision" method="POST">
                    <input type="hidden" name="decision" value="approve" />
                    <button type="submit" class="approve">Approve Access</button>
                    <button type="submit" class="deny" name="decision" value="deny">Deny</button>
                </form>
            </div>
        </body>
        </html>
    `;
}

// Authorization endpoint initiates EHR auth flow
app.get('/:configKey/authorize', async (req, res) => {
    const {
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        login_hint
    } = req.query;

    // Validate required parameters
    if (!response_type || response_type !== 'code' ||
        !client_id || !redirect_uri || !scope || !state) {
        return res.redirect(`${redirect_uri}?error=invalid_request&state=${state}`);
    }

    try {
        // Create authorization request record
        const authId = crypto.randomUUID();
        const authRequest = {
            id: authId,
            client_id,
            redirect_uri,
            scope,
            state,
            created_at: new Date(),
            approved: false,
            ehrTokenResponse: null
        };

        // Store the authorization request
        authorizationRequests.set(authId, authRequest);

        // Create state for EHR flow
        const ehrState = generateRandomString();
        const nonce = generateRandomString();
        const { verifier, challenge } = await generatePkce();

        // Store EHR flow data in session
        req.session.ehrFlow = {
            state: ehrState,
            authId,
            codeVerifier: verifier,
            created_at: new Date()
        };

        // Discover EHR endpoints
        const discoveryUrl = `${req.ehrContext.config.fhirBaseUrl}/.well-known/smart-configuration`;
        const discovery = await fetch(discoveryUrl).then(r => r.json());

      console.log("EHRC", req.ehrContext);
        // Build EHR authorization request URL
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: req.ehrContext.config.clientId,
            redirect_uri: `${req.ehrContext.baseUrl}/ehr-callback`,
            scope: req.ehrContext.config.scope,
            state: ehrState,
            nonce,
            aud: req.ehrContext.config.fhirBaseUrl,
            prompt: 'none',
            id_token_hint: login_hint,
            code_challenge: challenge,
            code_challenge_method: 'S256'
        });

        // Redirect to EHR authorization endpoint
        res.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);

    } catch (error) {
        console.error('Authorization initialization failed:', error);
        res.redirect(`${redirect_uri}?error=server_error&state=${state}`);
    }
});

// EHR callback displays authorization screen
app.get('/:configKey/ehr-callback', async (req, res) => {
    const { code, state, error } = req.query;

    // Validate session and state
    if (!req.session.ehrFlow || req.session.ehrFlow.state !== state) {
      console.log(req.session.ehrFlow)

        return res.status(400).send('Invalid state');
    }

    const { authId, codeVerifier } = req.session.ehrFlow;
    const authRequest = authorizationRequests.get(authId);

    if (error || !code) {
        return res.redirect(`${authRequest.redirect_uri}?error=access_denied&state=${authRequest.state}`);
    }

    try {
        // Discover EHR endpoints
        const discoveryUrl = `${req.ehrContext.config.fhirBaseUrl}/.well-known/smart-configuration`;
        const discovery = await fetch(discoveryUrl).then(r => r.json());

        // Exchange code for tokens with EHR
        const tokenResponse = await fetch(discovery.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code.toString(),
                redirect_uri: `${req.ehrContext.baseUrl}/ehr-callback`,
                client_id: req.ehrContext.config.clientId,
                code_verifier: codeVerifier
            }).toString()
        });

        if (!tokenResponse.ok) {
          console.log({
                grant_type: 'authorization_code',
                code: code.toString(),
                redirect_uri: `${req.ehrContext.baseUrl}/ehr-callback`,
                client_id: req.ehrContext.config.clientId,
                code_verifier: codeVerifier
            })
            console.log(tokenResponse);
            const errorBody = await tokenResponse.json();
          console.log(errorBody)
          console.log("From ehrc", req.ehrContext);
            throw new Error('Token exchange failed');
        }

        const ehrTokenResponse = await tokenResponse.json();
        authRequest.ehrTokenResponse = ehrTokenResponse;

        // Extract identity information for display
        const ehrIdentity = {
            name: 'User Name', // Extract from id_token or userinfo
            patient: ehrTokenResponse.patient
        };

        // Show authorization screen
        res.send(renderAuthorizationScreen(authRequest, ehrIdentity));

    } catch (error) {
        console.error('EHR token exchange failed:', error);
        return res.redirect(`${authRequest.redirect_uri}?error=server_error&state=${authRequest.state}`);
    }
});

app.post('/:configKey/imaging-decision', (req, res) => {
    // Validate session exists
    if (!req.session.ehrFlow) {
        console.log('No session found for decision');
        return res.status(400).send('Invalid session');
    }

    const { authId } = req.session.ehrFlow;
    const authRequest = authorizationRequests.get(authId);
    
    if (!authRequest || !authRequest.ehrTokenResponse) {
        console.log('No auth request found for', authId);
        return res.status(400).send('Invalid request');
    }

    // Clean up session immediately to prevent reuse
    delete req.session.ehrFlow;

    // Handle user's decision
    const { decision } = req.body;
    if (decision === 'approve') {
        console.log('Approving access for', authId);
        
        // Mark request as approved
        authRequest.approved = true;

        // Generate authorization code
        const authCode = crypto.randomUUID();

        // Store authorization code mapping and clean up original request
        authorizationRequests.set(authCode, authRequest);
        authorizationRequests.delete(authId);

        // Redirect back to client with code
        return res.redirect(`${authRequest.redirect_uri}?code=${authCode}&state=${authRequest.state}`);
    } else {
        console.log('Denying access for', authId);
        
        // Clean up the auth request
        authorizationRequests.delete(authId);
        
        // Redirect back to client with error
        return res.redirect(`${authRequest.redirect_uri}?error=access_denied&state=${authRequest.state}`);
    }
});

// Token endpoint
app.post('/:configKey/token', async (req, res) => {
    const {
        grant_type,
        code,
        redirect_uri,
        client_id
    } = req.body;

    // Validate request
    if (!grant_type || grant_type !== 'authorization_code' ||
        !code || !redirect_uri || !client_id) {
        return res.status(400).json({ error: 'invalid_request' });
    }

    // Lookup authorization request
    const authRequest = authorizationRequests.get(code);
    if (!authRequest) {
        return res.status(400).json({ error: 'invalid_grant' });
    }

    // Validate client_id and redirect_uri match original request
    if (authRequest.client_id !== client_id ||
        authRequest.redirect_uri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant' });
    }

    // Generate access token
    const accessToken = crypto.randomUUID();
    
    // Prepare public token response
    const tokenResponse = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: authRequest.scope,
        patient: authRequest.ehrTokenResponse.patient
    };

    // Store complete token data with internal context
    tokens.set(accessToken, {
        tokenResponse,  // Public response sent to client
        internalContext: {
            authRequest,
            createdAt: new Date(),
            ehrTokenResponse: authRequest.ehrTokenResponse
        }
    });

    // Delete used authorization code
    authorizationRequests.delete(code);

    // Return public token response
    res.json(tokenResponse);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`OAuth Imaging server listening on port ${PORT}`);
});
