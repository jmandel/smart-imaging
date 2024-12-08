// index.ts
class EventEmitter {
  listeners = {};
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]?.push(callback);
  }
  off(event, callback) {
    if (!this.listeners[event])
      return;
    this.listeners[event] = this.listeners[event]?.filter((cb) => cb !== callback);
  }
  emit(event) {
    const callbacks = this.listeners[event.type];
    if (callbacks) {
      callbacks.forEach((callback) => callback(event));
    }
  }
}

class SmartLaunch {
  config;
  codeVerifier = null;
  smartConfig = null;
  tokenResponse = null;
  tokenExpiryTimeout = null;
  authTab = null;
  state;
  emitter;
  usePKCE = false;
  authPromise = null;
  events;
  authPromiseResolve = null;
  authPromiseReject = null;
  storageKeyPrefix;
  constructor(config) {
    this.config = config;
    this.state = this.generateState();
    this.emitter = new EventEmitter;
    this.events = this.emitter;
    this.storageKeyPrefix = `smartLaunch_${btoa(`${config.clientId}_${config.fhirBaseUrl}`)}`;
    window.addEventListener("message", this.handleMessage.bind(this));
    this.loadTokenFromSession();
  }
  static initialize(config) {
    return new SmartLaunch(config);
  }

  authorize(options = {}) {
    if (this.authPromise) {
      return this.authPromise;
    }
    
    // If login_hint is provided, automatically set prompt=none
    if (options.login_hint && !options.prompt) {
      options.prompt = 'none';
    }
    
    this.authPromise = new Promise((resolve, reject) => {
      this.authPromiseResolve = resolve;
      this.authPromiseReject = reject;
      this.initiateLaunch(options);
    });
    return this.authPromise;
  }

  // Modify initiateLaunch to accept options
  async initiateLaunch(options = {}) {
    try {
      this.emitter.emit({ type: "launchInitiated" });
      await this.performDiscovery();
      this.usePKCE = this.shouldUsePKCE();
      
      if (this.usePKCE) {
        this.codeVerifier = this.generateCodeVerifier();
      }
      
      const codeChallenge = this.usePKCE ? 
        await this.generateCodeChallenge(this.codeVerifier) : 
        undefined;
      
      const redirectUri = this.resolveRedirectUri();
      const url = this.buildAuthorizationUrl(codeChallenge, redirectUri, this.state, options);
      
      this.authTab = window.open(url, "_blank");
      if (!this.authTab) {
        throw new Error("Failed to open authorization window.");
      }
    } catch (error) {
      this.emitter.emit({ type: "authorizationFailed", data: error });
      if (this.authPromiseReject) {
        this.authPromiseReject(error);
      }
    }
  }

  // Modify buildAuthorizationUrl to accept options
  buildAuthorizationUrl(codeChallenge, redirectUri, state, options = {}) {
    const params = {
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: this.config.scope,
      state,
      aud: this.config.fhirBaseUrl
    };

    // Add login_hint if provided
    if (options.login_hint) {
      params.login_hint = options.login_hint;
    }
    
    // Add prompt if provided
    if (options.prompt) {
      params.prompt = options.prompt;
    }
    
    // Add PKCE parameters if needed
    if (this.usePKCE && codeChallenge) {
      params.code_challenge = codeChallenge;
      params.code_challenge_method = "S256";
    }

    const queryString = new URLSearchParams(params).toString();
    return `${this.smartConfig?.authorization_endpoint}?${queryString}`;
  }
  shouldUsePKCE() {
    const pkceConfig = this.config.pkce || "conditional";
    switch (pkceConfig) {
      case "always":
        return true;
      case "never":
        return false;
      case "conditional":
      default:
        return this.smartConfig?.code_challenge_methods_supported?.includes("S256") ?? false;
    }
  }
  async exchangeCodeForToken(code, state) {
    if (state !== this.state) {
      const error = new Error("Invalid state parameter.");
      this.emitter.emit({ type: "authorizationFailed", data: error });
      if (this.authPromiseReject) {
        this.authPromiseReject(error);
      }
      return;
    }
    if (!this.smartConfig) {
      const error = new Error("SMART configuration not loaded.");
      this.emitter.emit({ type: "authorizationFailed", data: error });
      if (this.authPromiseReject) {
        this.authPromiseReject(error);
      }
      return;
    }
    const bodyParams = {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.resolveRedirectUri(),
      client_id: this.config.clientId
    };
    if (this.usePKCE && this.codeVerifier) {
      bodyParams["code_verifier"] = this.codeVerifier;
    }
    const body = new URLSearchParams(bodyParams);
    try {
      const response = await fetch(this.smartConfig.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });
      if (!response.ok) {
        const errorResponse = await response.json();
        throw new Error(`Token exchange failed: ${JSON.stringify(errorResponse)}`);
      }
      const rawTokenResponse = await response.json();
      this.tokenResponse = rawTokenResponse;
      this.extractContext(this.tokenResponse);
      this.scheduleTokenRefresh(this.tokenResponse.expires_in);
      this.saveTokenToSession(this.tokenResponse);
      this.emitter.emit({ type: "authorizationSucceeded", data: this.tokenResponse });
      if (this.authPromiseResolve) {
        this.authPromiseResolve(this.tokenResponse);
      }
      if (this.authTab) {
        this.authTab.close();
      }
    } catch (error) {
      this.emitter.emit({ type: "authorizationFailed", data: error });
      if (this.authPromiseReject) {
        this.authPromiseReject(error);
      }
    }
  }
  async refreshAccessToken() {
    if (!this.smartConfig) {
      throw new Error("SMART configuration not loaded.");
    }
    if (!this.tokenResponse?.refresh_token) {
      throw new Error("No refresh token available.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokenResponse.refresh_token,
      client_id: this.config.clientId
    });
    try {
      const response = await fetch(this.smartConfig.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });
      if (!response.ok) {
        const errorResponse = await response.json();
        throw new Error(`Token refresh failed: ${JSON.stringify(errorResponse)}`);
      }
      const rawTokenResponse = await response.json();
      this.tokenResponse = rawTokenResponse;
      this.extractContext(this.tokenResponse);
      this.scheduleTokenRefresh(this.tokenResponse.expires_in);
      this.saveTokenToSession(this.tokenResponse);
      this.emitter.emit({ type: "tokenRefreshed", data: this.tokenResponse });
      return this.tokenResponse;
    } catch (error) {
      this.emitter.emit({ type: "tokenRefreshFailed", data: error });
      this.clearTokenFromSession();
      throw error;
    }
  }
  async fetch(url, options = {}) {
    if (!this.tokenResponse) {
      throw new Error("Not authenticated. Please initiate launch.");
    }
    const interpolatedUrl = this.interpolateUrl(url, this.tokenResponse.patient, this.tokenResponse.encounter);
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.tokenResponse.access_token}`);
    headers.set("Accept", `application/json`);
    let fullUrl;
    if (interpolatedUrl.startsWith("http://") || interpolatedUrl.startsWith("https://")) {
      fullUrl = interpolatedUrl;
    } else {
      const baseUrl = this.config.fhirBaseUrl.replace(/\/$/, "");
      const relativeUrl = interpolatedUrl.replace(/^\//, "");
      fullUrl = `${baseUrl}/${relativeUrl}`;
    }
    let response = await fetch(fullUrl, {
      headers,
      ...options
    });
    if (response.status === 401) {
      if (this.tokenResponse.refresh_token) {
        try {
          await this.refreshAccessToken();
          headers.set("Authorization", `Bearer ${this.tokenResponse.access_token}`);
          response = await fetch(fullUrl, {
            ...options,
            headers
          });
        } catch (error) {
          throw new Error("Unauthorized and token refresh failed.");
        }
      } else {
        throw new Error("Unauthorized and no refresh token available.");
      }
    }
    return response;
  }
  extractContext(tokenResponse) { }
  async performDiscovery() {
    const discoveryUrl = `${this.config.fhirBaseUrl.replace(/\/$/, "")}/.well-known/smart-configuration`;
    try {
      const response = await fetch(discoveryUrl, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });
      if (!response.ok) {
        throw new Error(`Discovery failed with status ${response.status}`);
      }
      this.smartConfig = await response.json();
      if (this.config.authorizationEndpoint) {
        this.smartConfig.authorization_endpoint = this.config.authorizationEndpoint;
      }
      if (this.config.tokenEndpoint) {
        this.smartConfig.token_endpoint = this.config.tokenEndpoint;
      }
      if (!this.smartConfig.authorization_endpoint || !this.smartConfig.token_endpoint) {
        throw new Error("Discovery document is missing required endpoints.");
      }
    } catch (error) {
      throw new Error(`Discovery error: ${error.message || error}`);
    }
  }
  resolveRedirectUri() {
    if (!this.config.redirectUri) {
      const ret = window.location.origin + window.location.pathname + window.location.search;
      return ret.replace(/\/$/, "");
    }
    try {
      const url = new URL(this.config.redirectUri);
      return url.toString();
    } catch {
      return new URL(this.config.redirectUri, window.location.href).toString();
    }
  }
  async handleMessage(event) {
    console.log("handleMessage", event);
    const expectedOrigin = new URL(this.resolveRedirectUri()).origin;
    if (event.origin !== expectedOrigin) {
      console.warn(`Ignored message from unexpected origin: ${event.origin}`);
      return;
    }
    const data = event.data;
    if (data.type === "authorization_code") {
      const { code, state } = data;
      if (!code || !state) {
        const error = new Error("Authorization code or state is missing.");
        this.emitter.emit({ type: "authorizationFailed", data: error });
        if (this.authPromiseReject) {
          this.authPromiseReject(error);
        }
        return;
      }
      try {
        await this.exchangeCodeForToken(code, state);
      } catch (error) {
        console.error("Error exchanging code for token:", error);
      }
    } else if (data.type === "error") {
      const { error } = data;
      const err = new Error(`Authorization error: ${error}`);
      this.emitter.emit({ type: "authorizationFailed", data: err });
      if (this.authPromiseReject) {
        this.authPromiseReject(err);
      }
    }
  }
  static handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    if (code || error) {
      const message = {};
      if (code) {
        message.type = "authorization_code";
        message.code = code;
        message.state = state;
      } else if (error) {
        message.type = "error";
        message.error = error;
      }
      if (window.opener && window.opener !== window) {
        window.opener.postMessage(message, window.location.origin);
        window.close();
      }
    }
  }
  interpolateUrl(url, patientId, encounterId) {
    let interpolatedUrl = url;
    if (patientId) {
      interpolatedUrl = interpolatedUrl.replace(/{{\s*patient\s*}}/g, encodeURIComponent(patientId));
    }
    if (encounterId) {
      interpolatedUrl = interpolatedUrl.replace(/{{\s*encounter\s*}}/g, encodeURIComponent(encounterId));
    }
    return interpolatedUrl;
  }
  generateState() {
    const array = new Uint8Array(16);
    window.crypto.getRandomValues(array);
    return Array.from(array, (dec) => dec.toString(16)).join("");
  }
  generateCodeVerifier() {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return this.base64UrlEncode(array);
  }
  async generateCodeChallenge(codeVerifier) {
    const encoder = new TextEncoder;
    const data = encoder.encode(codeVerifier);
    const digest = await window.crypto.subtle.digest("SHA-256", data);
    return this.base64UrlEncode(new Uint8Array(digest));
  }
  base64UrlEncode(array) {
    return btoa(String.fromCharCode(...array)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  scheduleTokenRefresh(expiresIn) {
    if (this.tokenExpiryTimeout) {
      clearTimeout(this.tokenExpiryTimeout);
    }
    const refreshTime = (expiresIn - 300) * 1000;
    if (refreshTime > 0 && this.tokenResponse?.refresh_token) {
      this.tokenExpiryTimeout = window.setTimeout(() => {
        this.refreshAccessToken().catch((error) => {
          console.error("Token refresh failed:", error);
        });
      }, refreshTime);
    }
  }
  saveTokenToSession(tokenResponse) {
    try {
      const tokenData = {
        tokenResponse,
        timestamp: Date.now()
      };
      sessionStorage.setItem(this.storageKeyPrefix, JSON.stringify(tokenData));
    } catch (error) {
      console.error("Failed to save token to session storage:", error);
    }
  }
  async loadTokenFromSession() {
    try {
      const tokenDataString = sessionStorage.getItem(this.storageKeyPrefix);
      if (!tokenDataString)
        return;
      const tokenData = JSON.parse(tokenDataString);
      const { tokenResponse, timestamp } = tokenData;
      const elapsedSeconds = (Date.now() - timestamp) / 1000;
      if (elapsedSeconds < tokenResponse.expires_in) {
        this.tokenResponse = tokenResponse;
        this.extractContext(this.tokenResponse);
        this.scheduleTokenRefresh(tokenResponse.expires_in - elapsedSeconds);
        setTimeout(() => {
          this.emitter.emit({ type: "authorizationSucceeded", data: this.tokenResponse });
        });
      } else if (tokenResponse.refresh_token) {
        this.refreshAccessToken().catch((error) => {
          console.error("Failed to refresh token on load:", error);
          this.clearTokenFromSession();
        });
      } else {
        this.clearTokenFromSession();
      }
    } catch (error) {
      console.error("Failed to load token from session storage:", error);
      this.clearTokenFromSession();
    }
  }
  clearTokenFromSession() {
    try {
      sessionStorage.removeItem(this.storageKeyPrefix);
      this.tokenResponse = null;
      if (this.tokenExpiryTimeout) {
        clearTimeout(this.tokenExpiryTimeout);
        this.tokenExpiryTimeout = null;
      }
    } catch (error) {
      console.error("Failed to clear token from session storage:", error);
    }
  }
}
export {
  SmartLaunch
};
