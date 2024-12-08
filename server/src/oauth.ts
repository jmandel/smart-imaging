// oauth.ts
import { Hono, HTTPException } from "./deps.ts";
import { getCookie, setCookie } from "./deps.ts";
import { HonoEnv, isIndependentSmartTenant } from "./types.ts";
import { crypto } from "https://deno.land/std@0.203.0/crypto/mod.ts";
import { cors } from "./deps.ts";

// Add these interfaces after the imports and before the in-memory stores

interface EHRTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  patient?: string;
  id_token?: string;
}

interface EHRFlow {
  state: string;
  authCode: string;
  codeVerifier: string;
  created_at: Date;
}

interface AuthorizationRequest {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  created_at: Date;
  approved: boolean;
  ehrTokenResponse: EHRTokenResponse | null;
  clientRegistration: Record<string, unknown>;
  fhirUser?: any;
}

interface TokenData {
  authRequest: AuthorizationRequest;
  tokenResponse: {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    patient?: string;
  };
  created_at: Date;
}

// In-memory stores
const authorizationRequests = new Map<string, AuthorizationRequest>();
const tokens = new Map<string, TokenData>();
const sessions = new Map<string, { ehrFlow?: EHRFlow }>();

// Helper to generate random bytes as base64url
function generateRandomString() {
  const buffer = new Uint8Array(32); // 32 bytes = 256 bits
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// Generate PKCE values
async function generatePkce() {
  const verifier = generateRandomString();
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return { verifier, challenge };
}

// Add this helper function for the authorization screen HTML
function renderAuthorizationScreen(authRequest: AuthorizationRequest, fhirUser: any) {
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
                <p>User: ${fhirUser?.name?.[0]?.text || 
                          `${fhirUser?.name?.[0]?.given?.[0] || ''} ${fhirUser?.name?.[0]?.family || ''}`.trim() || 
                          'Unknown'}</p>
                <p>Patient: ${authRequest.ehrTokenResponse?.patient || 'Unknown'}</p>
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

export const oauthRouter = new Hono<HonoEnv>()
  // Add CORS middleware before other routes
  .use("*", cors({
    origin: "*", // You might want to restrict this based on your needs
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true, // Important for cookies
    maxAge: 3600,
  }))
  // Session handling middleware
  .use("*", async (c, next) => {
    if (!isIndependentSmartTenant(c.var.tenant)) {
      return c.notFound();
    }
    let sessionId = getCookie(c, "session_id");
    if (!sessionId) {
      sessionId = generateRandomString();
      setCookie(c, "session_id", sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: 3600,
        path: "/",
      });
    }
    
    let session = sessions.get(sessionId);
    if (!session) {
      session = {};
      sessions.set(sessionId, session);
    }
    
    c.set("session", session);
    console.log("Middlware Session", session);
    await next();
  })
  
  // Authorization endpoint
  .get("/authorize", async (c) => {
    const query = c.req.query();
    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      login_hint
    } = query;

    // Validate required parameters
    if (!response_type || response_type !== "code" ||
        !client_id || !redirect_uri || !scope || !state) {
      return c.redirect(`${redirect_uri}?error=invalid_request&state=${state}`);
    }

    try {
      // Create authorization request record
      const authCode = generateRandomString();
      // TODO: Fetch and validate client registration
      // const clientRegistration = await fetch(`${ehrBaseUrl}/.well-known/client-registrations/${client_id}`).then(r => r.json());
      const clientRegistration = {}; // Placeholder for now

      // TODO: Validate redirect_uri against registered URIs
      // if (!clientRegistration.redirect_uris?.includes(redirect_uri)) {
      //   return c.redirect(`${redirect_uri}?error=invalid_redirect_uri&state=${state}`);
      // }

      const authRequest = {
        client_id,
        redirect_uri,
        scope,
        state,
        created_at: new Date(),
        approved: false,
        ehrTokenResponse: null,
        clientRegistration
      };

      // Store the authorization request
      authorizationRequests.set(authCode, authRequest);

      // Create state for EHR flow
      const ehrState = generateRandomString();
      const nonce = generateRandomString();
      const { verifier, challenge } = await generatePkce();

      // Store EHR flow data in session
      const session = c.get("session");
      session.ehrFlow = {
        state: ehrState,
        authCode,
        codeVerifier: verifier,
        created_at: new Date()
      };
      console.log("authzSession", session);

      // Get EHR endpoints from tenant config
      const tenantConfig = c.var.tenant.config;
      const ehrBaseUrl = tenantConfig.authorization.fhirBaseUrl;
      
      // Discover endpoints
      const discoveryUrl = `${ehrBaseUrl}/.well-known/smart-configuration`;
      const discovery = await fetch(discoveryUrl).then(r => r.json());

      // Build EHR authorization request URL
      const paramValues = {
        response_type: "code",
        client_id: tenantConfig.authorization.client.client_id,
        redirect_uri: `${c.var.tenant.baseUrl}/oauth/ehr-callback`,
        scope: "openid fhirUser launch/patient patient/*.read",
        state: ehrState,
        nonce,
        aud: ehrBaseUrl,
        prompt: "none",
        id_token_hint: login_hint,
        code_challenge: challenge,
        code_challenge_method: "S256"
      } as const;

      const params = new URLSearchParams(
        Object.entries(paramValues)
          .filter(([_, value]) => value !== undefined && value !== null && value !== "")
      );

      // Redirect to EHR authorization endpoint
      return c.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);

    } catch (error) {
      console.error("Authorization initialization failed:", error);
      throw new HTTPException(500, { message: error.message });
    }
  })

  // EHR callback endpoint
  .get("/ehr-callback", async (c) => {
    const { code, state, error } = c.req.query();
    const session = c.get("session");

    console.log("ehrCallbackSession", session);
    console.log(code, state, error)

    // Validate session and state
    if ((session.ehrFlow as EHRFlow)?.state !== state) {
      throw new HTTPException(400, { message: "Invalid state" });
    }

    const { authCode, codeVerifier } = session.ehrFlow as EHRFlow;
    const authRequest = authorizationRequests.get(authCode)!;
    

    if (error || !code) {
      return c.redirect(`${authRequest.redirect_uri}?error=access_denied&state=${authRequest.state}`);
    }

    try {
      const tenantConfig = c.var.tenant.config;
      const ehrBaseUrl = tenantConfig.authorization.fhirBaseUrl;
      
      console.log("EHR Base URL", ehrBaseUrl);
      // Discover endpoints
      const discoveryUrl = `${ehrBaseUrl}/.well-known/smart-configuration`;
      const discovery = await fetch(discoveryUrl).then(r => r.json());

      console.log("Discovery", discovery);

      // Exchange code for tokens with EHR
      const tokenResponse = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code.toString(),
          redirect_uri: `${c.var.tenant.baseUrl}/oauth/ehr-callback`,
          client_id: tenantConfig.authorization.client.client_id,
          code_verifier: codeVerifier
        }).toString()
      });

      if (!tokenResponse.ok) {
        throw new Error("Token exchange failed");
      }

      const ehrTokenResponse = await tokenResponse.json();
      console.log("EHR's Token Response", ehrTokenResponse);

      // Update auth request with EHR token response
      authRequest.ehrTokenResponse = ehrTokenResponse;

      if (ehrTokenResponse.id_token) {
        const [_header, payload, _signature] = ehrTokenResponse.id_token.split('.');
        const decodedPayload = JSON.parse(atob(payload));
        
        if (decodedPayload.fhirUser) {
          const fhirUserUrl = decodedPayload.fhirUser.startsWith('http') 
            ? decodedPayload.fhirUser
            : `${ehrBaseUrl}/${decodedPayload.fhirUser.startsWith('/') ? decodedPayload.fhirUser.slice(1) : decodedPayload.fhirUser}`;

          try {
            const userResponse = await fetch(fhirUserUrl, {
              headers: {
                'Authorization': `Bearer ${ehrTokenResponse.access_token}`,
                'Accept': 'application/fhir+json'
              }
            });
            
            if (userResponse.ok) {
              const fhirUser = await userResponse.json();
              // Store the FHIR user in the auth request
              authRequest.fhirUser = fhirUser;
              // Show authorization screen with FHIR user data
              return new Response(renderAuthorizationScreen(authRequest, fhirUser), {
                headers: { "Content-Type": "text/html" }
              });
            }
          } catch (userError) {
            console.error("Failed to fetch user info:", userError);
          }
        }
      }

      // Fallback if we couldn't get user info
      return new Response(renderAuthorizationScreen(authRequest, null), {
        headers: { "Content-Type": "text/html" }
      });

    } catch (error) {
      console.error("EHR token exchange failed:", error);
      return c.redirect(`${authRequest.redirect_uri}?error=server_error&state=${authRequest.state}`);
    }
  })

  // Add new imaging decision endpoint
  .post("/imaging-decision", async (c) => {
    const session = c.get("session");
    if (!session.ehrFlow) {
      throw new HTTPException(400, { message: "Invalid session" });
    }

    const { authCode } = session.ehrFlow as EHRFlow;
    const authRequest = authorizationRequests.get(authCode);
    
    if (!authRequest || !authRequest.ehrTokenResponse) {
      throw new HTTPException(400, { message: "Invalid request" });
    }

    // Clean up session
    delete session.ehrFlow;

    const formData = await c.req.parseBody();
    const { decision } = formData;

    if (decision === "approve") {
      // Mark request as approved
      authRequest.approved = true;
      return c.redirect(`${authRequest.redirect_uri}?code=${authCode}&state=${authRequest.state}`);
    } else {
      // Clean up the auth request
      authorizationRequests.delete(authCode);
      return c.redirect(`${authRequest.redirect_uri}?error=access_denied&state=${authRequest.state}`);
    }
  })

  // Token endpoint
  .post("/token", async (c) => {
    const formData = await c.req.parseBody();
    const {
      grant_type,
      code,
      redirect_uri,
      client_id
    } = formData;

    // Validate request
    if (!grant_type || grant_type !== "authorization_code" ||
        !code || !redirect_uri || !client_id) {
      c.status(400);
      return c.json({ error: "invalid_request" });
    }

    // Lookup authorization request
    const authRequest = authorizationRequests.get(code as string);
    if (!authRequest) {
      c.status(400);
      return c.json({ error: "invalid_grant" });
    }

    // Validate client_id and redirect_uri match original request
    if (authRequest.client_id !== client_id ||
        authRequest.redirect_uri !== redirect_uri) {
      c.status(400);
      return c.json({ error: "invalid_grant" });
    }

    // TODO: Validate client authentication
    // const clientAssertion = formData.client_assertion;
    // if (authRequest.clientRegistration.requiresAssertion && !await validateClientAssertion(clientAssertion, authRequest.clientRegistration)) {
    //   c.status(401);
    //   return c.json({ error: "invalid_client" });
    // }

    // Verify request is approved and has EHR tokens
    if (!authRequest.approved || !authRequest.ehrTokenResponse) {
      c.status(400);
      return c.json({ error: "access_denied" });
    }

    // Generate access token
    const accessToken = generateRandomString();
    const tokenResponse = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: authRequest.scope,
      patient: authRequest.ehrTokenResponse.patient // Pass through patient context but not id_token
    };

    // Store token with full context
    tokens.set(accessToken, {
      authRequest: authRequest,
      tokenResponse,
      created_at: new Date(),
    });

    // Delete used authorization code
    authorizationRequests.delete(code as string);

    // Return token response (without id_token)
    return c.json(tokenResponse);
  });