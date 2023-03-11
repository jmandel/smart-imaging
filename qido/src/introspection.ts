import { jose, oak } from "./deps.ts";
import { AppState, IntrospectionResponse, Patient } from "./types.ts";

type IntrospectionConfig = {
  fhirBaseUrl: string;
  scope: string;
  client: {
    client_id: string;
    jwk: { alg: "ES384" | "RS384"; kid: string };
    jwkPrivate: unknown;
  };
} & ({ type: "smart-on-fhir" } | { type: "smart-on-fhir-with-epic-bugfixes" });

interface SmartConfiguration {
  token_endpoint: string;
  introspection_endpoint: string;
}

export class Introspection {
  public cache: { smartConfiguration?: SmartConfiguration } = {};
  static create(config: IntrospectionConfig): Introspection {
    if (config.type === "smart-on-fhir-with-epic-bugfixes") {
      return new IntrospectionEpic(config);
    } else {
      return new Introspection(config);
    }
  }

  constructor(public config: IntrospectionConfig) {}

  async getSmartConfiguration() {
    if (!this.cache.smartConfiguration) {
      const smartConfig = await fetch(
        `${this.config.fhirBaseUrl}/.well-known/smart-configuration`,
        {
          headers: { accept: "application/json" },
        },
      );
      const smartConfigJson = await smartConfig.json();
      this.cache.smartConfiguration = smartConfigJson as SmartConfiguration;
    }

    return this.cache.smartConfiguration;
  }

  async tokenEndpoint() {
    return (await this.getSmartConfiguration()).token_endpoint;
  }

  async introspectionEndpoint() {
    return (await this.getSmartConfiguration()).introspection_endpoint;
  }

  async generateClientAssertion() {
    return new jose.SignJWT({})
      .setIssuer(this.config.client.client_id)
      .setSubject(this.config.client.client_id)
      .setAudience(await this.tokenEndpoint())
      .setExpirationTime("3 minutes")
      .setJti(crypto.randomUUID())
      .setProtectedHeader({
        alg: this.config.client.jwk.alg,
        kid: this.config.client.jwk.kid,
        typ: "JWT",
      })
      .sign(await jose.importJWK(this.config.client.jwkPrivate as jose.JWK));
  }

  async getAccessToken() {
    const accessTokenResponse = await fetch(await this.tokenEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["scope", this.config.scope],
        ["grant_type", "client_credentials"],
        [
          "client_assertion_type",
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        ],
        ["client_assertion", await this.generateClientAssertion()],
      ]).toString(),
    });
    const accessTokenJson = await accessTokenResponse.json();
    console.log("AT", accessTokenJson.access_token);
    return accessTokenJson as { access_token: string; expires_in: number };
  }

  async introspect(tokenToIntrospect: string, accessToken: string) {
    const introspectionResponse = await fetch(
      await this.introspectionEndpoint(),
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${accessToken}`,
        },
        body: new URLSearchParams([["token", tokenToIntrospect]]).toString(),
      },
    );
    return (await introspectionResponse.json()) as IntrospectionResponse;
  }

  async resolvePatient(
    introspected: IntrospectionResponse,
    accessToken: string,
  ): Promise<Patient | null> {
    if (!introspected.patient) {
      return null;
    }
    const patientUrl = this.config.fhirBaseUrl + "/Patient/" +
      introspected.patient;
    const patientResponse = await fetch(patientUrl, {
      method: "POST",
      headers: {
        accept: "application/fhir+json",
        authorization: `Bearer ${accessToken}`,
      },
    });

    return (await patientResponse.json()) as Patient;
  }

  allowsImaging(introspected: IntrospectionResponse) {
    const scopes = introspected.scope.split(/\s+/);
    return [
      "patient/*.*",
      "patient/*.read",
      "patient/*.rs",
      "patient/ImagingStudy.read",
      "patient/ImagingStudy.*",
      "patient/ImagingStudy.rs",
    ].some((s) => scopes.includes(s));
  }
  async getAuthorizationContext(tokenToIntrospect: string) {
    const accessToken = (await this.getAccessToken()).access_token;
    const introspected = await this.introspect(tokenToIntrospect, accessToken);
    const patient = await this.resolvePatient(introspected, accessToken);
    console.log("P", patient);
    return { patient, introspected };
  }

  async assignAuthorization(ctx: oak.Context<AppState>) {
    const tokenToIntrospect = ctx.request.headers
      .get("authorization")
      ?.split(/bearer /i)?.[1];
    if (!tokenToIntrospect) {
      throw "Cannot authorize without an access token";
    }
    const { patient, introspected } = await this.getAuthorizationContext(
      tokenToIntrospect,
    );
    console.log(patient, introspected);
    if (!introspected.active) {
      throw "Must have an active access token";
    }
    if (!this.allowsImaging(introspected)) {
      throw "Must have imaging scopes";
    }
    if (!patient?.id) {
      throw "Must be authorized against a patient";
    }
    ctx.state.authorizedForPatient = patient;
    ctx.state.introspected = introspected;
  }
}

export class IntrospectionEpic extends Introspection {
  async introspectionEndpoint() {
    const tokenEndpoint = await this.tokenEndpoint();
    return tokenEndpoint.replace(/\/token$/, "/introspect");
  }

  constructor(config: IntrospectionConfig) {
    super(config);
  }
}
