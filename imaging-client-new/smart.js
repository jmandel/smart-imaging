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
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event]?.filter((cb) => cb !== callback);
  }
  emit(event) {
    const callbacks = this.listeners[event.type];
    if (callbacks) {
      callbacks.forEach((callback) => callback(event));
    }
  }
}

class MultiSmartLaunch {
  constructor(servers) {
    this.servers = servers;
    this.currentServerIndex = 0;
    this.tokens = {};
    this.state = this.generateState();
    this.storageKeyPrefix = "multiSmartLaunch";
    this.serverConfigs = {};

    // Bind methods
    this.handleMessage = this.handleMessage.bind(this);
    window.addEventListener("message", this.handleMessage);
  }

  static initialize(servers) {
    return new MultiSmartLaunch(servers);
  }

  authorize() {
    if (this.authPromise) {
      return this.authPromise;
    }

    this.authPromise = new Promise((resolve, reject) => {
      this.authPromiseResolve = resolve;
      this.authPromiseReject = reject;
      this.startNextServerAuth();
    });

    return this.authPromise;
  }

  async startNextServerAuth() {
    if (this.currentServerIndex >= this.servers.length) {
      // All servers authenticated
      if (this.authTab) {
        this.authTab.close();
      }
      this.authPromiseResolve(this.tokens);
      return;
    }

    const currentServer = this.servers[this.currentServerIndex];

    // Fetch SMART configuration if not already cached
    if (!this.serverConfigs[currentServer.fhirBaseUrl]) {
      this.serverConfigs[currentServer.fhirBaseUrl] = await this.fetchSmartConfiguration(currentServer);
    }

    this.saveStateToSession();
    const url = await this.buildAuthorizationUrl(currentServer);

    if (!this.authTab || this.authTab.closed) {
      this.authTab = window.open(url, "_blank");
    } else {
      this.authTab.location.href = url;
    }

    if (!this.authTab) {
      throw new Error("Failed to open authorization window.");
    }
  }

  // Static method to handle the redirect callback
  static async handleCallback() {
    // Clear the page content and show loading message
    document.body.innerHTML = '<div style="text-align: center; margin-top: 2em;">Authorizing...</div>';

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (code || error) {
      const message = {
        type: error ? "error" : "authorization_code",
        code,
        error,
      };

      if (window.opener && window.opener !== window) {
        window.opener.postMessage(message, window.location.origin);
      }
    }
  }

  async handleMessage(event) {
    if (event.origin !== window.location.origin) {
      return;
    }

    const data = event.data;

    if (data.type === "authorization_code") {
      try {
        const currentServer = this.servers[this.currentServerIndex];
        const tokenResponse = await this.exchangeCodeForToken(currentServer, data.code);

        // Store token response for this server
        this.tokens[currentServer.fhirBaseUrl] = tokenResponse;

        // Move to next server
        // await new Promise(resolve => setTimeout(resolve, 1000));
        this.currentServerIndex++;
        this.startNextServerAuth();
      } catch (error) {
        this.handleError(error);
      }
    } else if (data.type === "error") {
      this.handleError(new Error(`Authorization error: ${data.error}`));
    }
  }

  // ... (keep other utility methods like generateState, etc.)

  saveStateToSession() {
    const stateData = {
      currentServerIndex: this.currentServerIndex,
      tokens: this.tokens,
      state: this.state,
      serverConfigs: this.serverConfigs,
    };
    sessionStorage.setItem(this.storageKeyPrefix, JSON.stringify(stateData));
  }

  loadStateFromSession() {
    const stateData = JSON.parse(sessionStorage.getItem(this.storageKeyPrefix));
    if (stateData) {
      this.currentServerIndex = stateData.currentServerIndex;
      this.tokens = stateData.tokens;
      this.state = stateData.state;
      this.serverConfigs = stateData.serverConfigs;
      return true;
    }
    return false;
  }

  clearStateFromSession() {
    sessionStorage.removeItem(this.storageKeyPrefix);
  }

  generateState() {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  buildAuthorizationUrl(server) {
    const config = this.serverConfigs[server.fhirBaseUrl];
    if (!config || !config.authorization_endpoint) {
      throw new Error("SMART configuration not found or invalid");
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: server.clientId,
      redirect_uri: window.location.origin + window.location.pathname,
      scope: server.scope,
      state: this.state,
      aud: server.fhirBaseUrl,
    });

    // If useHint is true and we have a previous server's id_token, use it as login_hint
    if (server.useHint && this.currentServerIndex > 0) {
      const previousServerUrl = this.servers[0].fhirBaseUrl;
      const previousTokens = this.tokens[previousServerUrl];
      params.append("login_hint", previousTokens.id_token);
    }

    if (server.additionalParams) {
      Object.entries(server.additionalParams).forEach(([key, value]) => {
        params.append(key, value);
      });
    }

    return `${config.authorization_endpoint}?${params.toString()}`;
  }

  async exchangeCodeForToken(server, code) {
    const config = this.serverConfigs[server.fhirBaseUrl];
    if (!config || !config.token_endpoint) {
      throw new Error("SMART configuration not found or invalid");
    }

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: window.location.origin + window.location.pathname,
      client_id: server.clientId,
    });

    const response = await fetch(config.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.statusText}`);
    }

    return await response.json();
  }

  handleError(error) {
    this.clearStateFromSession();
    if (this.authTab) {
      this.authTab.close();
    }
    if (this.authPromiseReject) {
      this.authPromiseReject(error);
    }
  }

  async fetchSmartConfiguration(server) {
    const wellKnownUrl = `${server.fhirBaseUrl}/.well-known/smart-configuration`;
    const response = await fetch(wellKnownUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch SMART configuration: ${response.statusText}`);
    }

    return await response.json();
  }
}

export { MultiSmartLaunch };

if (window.location.search.includes("code=") || window.location.search.includes("error=")) {
  MultiSmartLaunch.handleCallback();
}
