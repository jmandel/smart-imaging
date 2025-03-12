// oauth.ts
import { 
  Hono, 
  HTTPException, 
  getCookie, 
  setCookie, 
  cors, 
  crypto, 
  jose, 
  StatusCode 
} from "./deps.ts";
import { HonoEnv, isIndependentSmartTenant } from "./types.ts";

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
  // deno-lint-ignore no-explicit-any
  ehrFhirUserRaw?: any;
  // deno-lint-ignore no-explicit-any
  userUrl?: any;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  created_at: Date;
  approved: boolean;
  ehrTokenResponse: EHRTokenResponse | null;
  clientRegistration: Record<string, unknown> | ClientMetadata;
  // deno-lint-ignore no-explicit-any
  ehrFhirUser?: any;
  // deno-lint-ignore no-explicit-any
  ehrPatient?: any;
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

// Add this interface for client metadata
interface ClientMetadata {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types?: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
  jwks_uri?: string;  // URL to the client's JWK Set
  jwks?: jose.JSONWebKeySet;  // Directly provided JWK Set
  // Add other fields as needed
}

// In-memory stores
const authorizationRequests = new Map<string, AuthorizationRequest>();
export const tokens = new Map<string, TokenData>();
const sessions = new Map<string, { ehrFlow?: EHRFlow }>();

// Add a simple in-memory JTI cache for preventing replay attacks
const usedJtis = new Map<string, { exp: number, iat: Date }>();

// Add a function to clean up expired JTIs occasionally
function cleanupExpiredJtis() {
  const now = new Date();
  for (const [jti, data] of usedJtis.entries()) {
    // Remove JTIs that have been stored for more than 5 minutes
    if ((now.getTime() - data.iat.getTime()) > 5 * 60 * 1000) {
      usedJtis.delete(jti);
    }
  }
}

// Add a function to verify client JWT assertions
async function verifyClientAssertion(
  clientAssertion: string, 
  clientMetadata: ClientMetadata,
  tokenEndpointUrl: string
): Promise<boolean> {
  try {
    // Get header and payload separately - this is the correct approach
    const header = jose.decodeProtectedHeader(clientAssertion);
    const _payload = jose.decodeJwt(clientAssertion);
    
    if (!header.kid) {
      console.error("JWT is missing 'kid' header");
      return false;
    }
    
    if (header.typ !== 'JWT') {
      console.error("JWT has invalid 'typ' header, expected 'JWT'");
      return false;
    }
    
    // Ensure we have the client's public keys
    let jwks: jose.JSONWebKeySet | null = null;
    
    // Try to get keys from jwks_uri if available
    if (clientMetadata.jwks_uri) {
      try {
        const response = await fetch(clientMetadata.jwks_uri);
        if (response.ok) {
          jwks = await response.json() as jose.JSONWebKeySet;
        } else {
          console.error(`Failed to fetch JWK Set from ${clientMetadata.jwks_uri}: ${response.status}`);
        }
      } catch (error) {
        console.error(`Error fetching JWK Set: ${error}`);
      }
    }
    
    // Fall back to direct jwks if provided
    if (!jwks && clientMetadata.jwks) {
      jwks = clientMetadata.jwks;
    }
    
    if (!jwks || !jwks.keys || jwks.keys.length === 0) {
      console.error("No public keys available for client");
      return false;
    }
    
    // Find the key matching the kid in the JWT header
    const signingKey = jwks.keys.find(key => key.kid === header.kid);
    if (!signingKey) {
      console.error(`No key found with id ${header.kid}`);
      return false;
    }
    
    // Verify JWT signature and claims
    const { payload: verifiedPayload } = await jose.jwtVerify(
      clientAssertion,
      await jose.importJWK(signingKey),
      {
        audience: tokenEndpointUrl,
        issuer: clientMetadata.client_id,
        subject: clientMetadata.client_id,
        clockTolerance: 5 * 60, // 5 minutes tolerance for clock skew
      }
    );
    
    // Verify required claims
    if (!verifiedPayload.jti || typeof verifiedPayload.jti !== 'string') {
      console.error("JWT is missing 'jti' claim");
      return false;
    }
    
    // Check if this JTI has been used before (prevent replay attacks)
    if (usedJtis.has(verifiedPayload.jti as string)) {
      console.error("JWT with this 'jti' has already been used");
      return false;
    }
    
    // Store JTI to prevent reuse
    usedJtis.set(verifiedPayload.jti as string, { 
      exp: verifiedPayload.exp as number, 
      iat: new Date() 
    });
    
    // Occasionally clean up expired JTIs
    if (Math.random() < 0.1) { // ~10% chance on each verification
      cleanupExpiredJtis();
    }
    
    // If we got here, everything validated
    return true;
  } catch (error) {
    console.error("JWT verification failed:", error);
    return false;
  }
}

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
function renderAuthorizationScreen(authRequest: AuthorizationRequest) {
  const userName = authRequest.ehrFhirUser?.name?.[0]?.text || 
                  `${authRequest.ehrFhirUser?.name?.[0]?.given?.[0] || ''} ${authRequest.ehrFhirUser?.name?.[0]?.family || ''}`.trim() || 
                  'Unknown';
  
  const patientName = authRequest.ehrPatient?.name?.[0]?.text ||
                     `${authRequest.ehrPatient?.name?.[0]?.given?.[0] || ''} ${authRequest.ehrPatient?.name?.[0]?.family || ''}`.trim() ||
                     'Unknown';
  
  // Get the client name from metadata if available, otherwise fall back to client_id
  const clientMetadata = authRequest.clientRegistration as unknown as ClientMetadata;
  const clientName = clientMetadata.client_name || authRequest.client_id;

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
                <p>The application <strong>${clientName}</strong> is requesting access to imaging studies.</p>
                <p>User: ${userName}</p>
                <p>Patient: ${patientName}</p>
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

// Add a helper function for standardized error redirects
function errorRedirect(redirectUri: string, error: string, state?: string, errorDescription?: string) {
  const params = new URLSearchParams();
  params.set('error', error);
  
  if (state) {
    params.set('state', state);
  }
  
  if (errorDescription) {
    params.set('error_description', errorDescription);
  }
  
  return `${redirectUri}?${params.toString()}`;
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
    if (!response_type || !client_id || !redirect_uri || !scope) {
      // Don't redirect if redirect_uri is missing or invalid
      c.status(400);
      return c.text("Invalid request: missing required parameters");
    }

    if (response_type !== "code") {
      return c.redirect(errorRedirect(
        redirect_uri as string,
        "unsupported_response_type",
        state as string,
        "This server only supports the authorization code flow"
      ));
    }

    if (!state) {
      return c.redirect(errorRedirect(
        redirect_uri as string,
        "invalid_request",
        undefined,
        "The state parameter is required"
      ));
    }

    try {
      // Create authorization request record
      const authCode = generateRandomString();
      
      // Get tenant config
      const tenantConfig = c.var.tenant.config;
      
      // Initialize with basic client information
      // We'll fetch complete metadata after EHR authentication
      const authRequest = {
        client_id,
        redirect_uri,
        scope,
        state,
        created_at: new Date(),
        approved: false,
        ehrTokenResponse: null,
        clientRegistration: {} // Empty for now, will populate later
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
      const ehrBaseUrl = tenantConfig.authorization.fhirBaseUrl;
      
      // Discover endpoints
      const discoveryUrl = `${ehrBaseUrl}/.well-known/smart-configuration`;
      const discovery = await fetch(discoveryUrl).then(r => r.json());

      // Build EHR authorization request URL
      const paramValues = {
        response_type: "code",
        client_id: tenantConfig.authorization.client.client_id,
        redirect_uri: `${c.var.tenant.baseUrl}/oauth/ehr-callback`,
        scope: "openid fhirUser launch/patient patient/*.* user/*.*",
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
      // Only redirect if we have a valid redirect_uri and state
      if (redirect_uri && state) {
        return c.redirect(errorRedirect(
          redirect_uri as string,
          "server_error",
          state as string,
          "The server encountered an unexpected condition"
        ));
      }
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
      console.log("EHR's Token Response", JSON.stringify(ehrTokenResponse, null, 2));

      // Update auth request with EHR token response
      authRequest.ehrTokenResponse = ehrTokenResponse;

      // NOW fetch client metadata using EHR access token
      // First try from tenant config, then fallback to discovery document
      let clientLookupUrl = tenantConfig.authorization.clientLookupUrl;

      // If not in tenant config, check for client_info_endpoint in the discovery document
      if (!clientLookupUrl && discovery.client_info_endpoint) {
        clientLookupUrl = discovery.client_info_endpoint;
        console.log(`Using client_info_endpoint from discovery: ${clientLookupUrl}`);
      }

      if (clientLookupUrl) {
        try {
          // Ensure the URL ends with a trailing slash before appending the client_id
          const baseUrl = clientLookupUrl.endsWith('/') ? clientLookupUrl : `${clientLookupUrl}/`;
          const clientMetadataResponse = await fetch(`${baseUrl}${authRequest.client_id}`, {
            headers: {
              'Authorization': `Bearer ${ehrTokenResponse.access_token}`,
              'Accept': 'application/json'
            }
          });
          
          if (clientMetadataResponse.ok) {
            const clientRegistration = await clientMetadataResponse.json();
            authRequest.clientRegistration = clientRegistration;
            
            // Validate redirect_uri against registered URIs
            if (Array.isArray(clientRegistration.redirect_uris) && 
                !clientRegistration.redirect_uris.includes(authRequest.redirect_uri as string)) {
              console.error(`Invalid redirect_uri: ${authRequest.redirect_uri}. Allowed URIs:`, clientRegistration.redirect_uris);
              return c.redirect(errorRedirect(
                authRequest.redirect_uri as string,
                "invalid_request",
                authRequest.state as string,
                "The redirect_uri is not registered for this client"
              ));
            }
          } else {
            console.warn(`Client metadata not found for ${authRequest.client_id}: ${clientMetadataResponse.status}`);
            if (clientMetadataResponse.status === 404) {
              return c.redirect(errorRedirect(
                authRequest.redirect_uri as string,
                "unauthorized_client",
                authRequest.state as string,
                "Client not found or not registered"
              ));
            }
          }
        } catch (error) {
          console.error("Error fetching client metadata:", error);
        }
      } else {
        console.warn("No client lookup URL available, skipping client validation");
      }

      // Fetch both user and patient information
      if (ehrTokenResponse.id_token) {
        const [_header, payload, _signature] = ehrTokenResponse.id_token.split('.');
        const decodedPayload = JSON.parse(atob(payload));
        console.log("ID Token Payload", JSON.stringify(decodedPayload, null, 2));
        
        try {
          // Fetch FHIR user info
          if (decodedPayload.fhirUser) {
            const fhirUserUrl = decodedPayload.fhirUser.startsWith('http') 
              ? decodedPayload.fhirUser
              : `${ehrBaseUrl}/${decodedPayload.fhirUser.startsWith('/') ? decodedPayload.fhirUser.slice(1) : decodedPayload.fhirUser}`;

            const userResponse = await fetch(fhirUserUrl, {
              headers: {
                'Authorization': `Bearer ${ehrTokenResponse.access_token}`,
                'Accept': 'application/fhir+json'
              }
            });

            console.log("Got user", userResponse);
            if (userResponse.ok) {
              authRequest.ehrFhirUser = await userResponse.json();
              authRequest.userUrl = fhirUserUrl;
              authRequest.ehrFhirUserRaw = decodedPayload
            } else {
              console.log("Failed to get fhirUser", fhirUserUrl)
            }
          }

          // Check for patient context - first from access token
          if (!ehrTokenResponse.patient && decodedPayload.fhirUser) {
            // If no patient in access token, try to extract from fhirUser in id_token
            authRequest.ehrPatient = authRequest.ehrFhirUser;
            console.log(`Using patient ${decodedPayload.fhirUser} from id_token's fhirUser claim`);
          }

          // Fetch patient info if we have a patient context
          if (ehrTokenResponse.patient) {
            const patientUrl = `${ehrBaseUrl}/Patient/${ehrTokenResponse.patient}`;
            const patientResponse = await fetch(patientUrl, {
              headers: {
                'Authorization': `Bearer ${ehrTokenResponse.access_token}`,
                'Accept': 'application/fhir+json'
              }
            });

            if (patientResponse.ok) {
              authRequest.ehrPatient = await patientResponse.json();
            }
          }
        } catch (error) {
          console.error("Failed to fetch user or patient info:", error);
        }
      }

      // Show authorization screen with both user and patient data
      console.log("renderAuthorizationScreen", authRequest);
      return new Response(renderAuthorizationScreen(authRequest), {
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

  // Token endpoint - implement standardized error responses
  .post("/token", async (c) => {
    const formData = await c.req.parseBody();
    const {
      grant_type,
      code,
      redirect_uri,
      client_id,
      client_assertion_type,
      client_assertion
    } = formData;

    // Helper for token endpoint errors
    function tokenError(error: string, status = 400, description?: string) {
      c.status(status as StatusCode);
      const response: Record<string, string> = { error };
      if (description) {
        response.error_description = description;
      }
      return c.json(response);
    }

    // Validate request
    if (!grant_type || grant_type !== "authorization_code" ||
        !code || !redirect_uri || !client_id) {
      return tokenError("invalid_request", 400, "Missing required parameters");
    }

    // Lookup authorization request
    const authRequest = authorizationRequests.get(code as string);
    if (!authRequest) {
      return tokenError("invalid_grant", 400, "The authorization code is invalid or expired");
    }

    // Validate client_id and redirect_uri match original request
    if (authRequest.client_id !== client_id ||
        authRequest.redirect_uri !== redirect_uri) {
      return tokenError("invalid_grant", 400, "The client_id or redirect_uri does not match the original request");
    }

    // Validate client authentication if needed
    const clientMetadata = authRequest.clientRegistration as unknown as ClientMetadata;
    const authMethod = clientMetadata.token_endpoint_auth_method || 'client_secret_post';
    
    // Check if client needs authentication
    let clientAuthenticated = false;
    
    if (authMethod === 'private_key_jwt' || authMethod === 'client_secret_jwt') {
      // JWT-based authentication
      if (client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !client_assertion) {
        return tokenError("invalid_client", 401, "Missing or invalid client assertion");
      }
      
      // Get token endpoint URL from tenant config
      const tokenEndpointUrl = `${c.var.tenant.baseUrl}/oauth/token`;
      
      // Verify the JWT assertion
      clientAuthenticated = await verifyClientAssertion(
        client_assertion as string,
        clientMetadata,
        tokenEndpointUrl
      );
      
      if (!clientAuthenticated) {
        return tokenError("invalid_client", 401, "Client authentication failed: invalid JWT assertion");
      }
    }
    else if (clientMetadata.client_secret) {
      const client_secret = formData.client_secret;
      
      // Basic authentication in header
      if (authMethod === 'client_secret_basic') {
        const authHeader = c.req.header('Authorization');
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          return tokenError("invalid_client", 401, "Client authentication failed: missing or invalid Authorization header");
        }
        
        const credentials = atob(authHeader.substring(6)).split(':');
        if (credentials.length !== 2 || 
            credentials[0] !== client_id || 
            credentials[1] !== clientMetadata.client_secret) {
          return tokenError("invalid_client", 401, "Client authentication failed: invalid credentials");
        }
        clientAuthenticated = true;
      } 
      // Form-encoded client_secret in body
      else if (authMethod === 'client_secret_post') {
        if (!client_secret || client_secret !== clientMetadata.client_secret) {
          return tokenError("invalid_client", 401, "Client authentication failed: invalid client_secret");
        }
        clientAuthenticated = true;
      }
    } else {
      // Public client - no authentication needed
      clientAuthenticated = true;
    }

    // If client authentication failed
    if (!clientAuthenticated) {
      return tokenError("invalid_client", 401, "Client authentication failed");
    }

    // Verify request is approved and has EHR tokens
    if (!authRequest.approved || !authRequest.ehrTokenResponse) {
      return tokenError("access_denied", 400, "The authorization request was not approved");
    }

    // Generate access token
    const accessToken = generateRandomString();
    const tokenResponse = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: authRequest.scope,
      patient: authRequest.ehrTokenResponse.patient
      // deterministically generate a patient id from the EHR's patient id
      // patient: await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authRequest.ehrTokenResponse.patient)).then(r => btoa(String.fromCharCode(...new Uint8Array(r)))).then(r => r.replace(/=+$/, ""))
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
