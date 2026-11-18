import { describe, expect, it } from "vitest";

import { REDACTION_MARKERS, redactText, redactValue } from "../src/redaction/redact.js";

describe("redactText", () => {
  it("tapa emails conservando el resto de la linea", () => {
    const result = redactText("customer jane.doe@example.com opened a refund");
    expect(result.text).toBe(`customer ${REDACTION_MARKERS.email} opened a refund`);
    expect(result.redactions).toBe(1);
  });

  it("tapa IPs y tokens bearer", () => {
    const ip = redactText("request from 203.0.113.42 rejected");
    expect(ip.text).toBe(`request from ${REDACTION_MARKERS.ipv4} rejected`);

    const token = redactText("Authorization: Bearer sk_live_51H8xQabcdefgh");
    expect(token.text).not.toContain("sk_live_51H8xQabcdefgh");
  });

  it("tapa asignaciones de secretos sin comerse la clave", () => {
    const result = redactText("db password=hunter2 user=beacon");
    expect(result.text).toBe(`db password=${REDACTION_MARKERS.secret} user=beacon`);
  });

  it("tapa claves de AWS y JWT", () => {
    const aws = redactText("found AKIAIOSFODNN7EXAMPLE in env");
    expect(aws.text).toBe(`found ${REDACTION_MARKERS.awsKey} in env`);

    const jwt = redactText("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl");
    expect(jwt.text).toContain(REDACTION_MARKERS.jwt);
  });

  it("no toca versiones ni identificadores normales", () => {
    const result = redactText("deployed checkout@1.42.0 commit a1b2c3d4e5f6");
    expect(result.text).toBe("deployed checkout@1.42.0 commit a1b2c3d4e5f6");
    expect(result.redactions).toBe(0);
  });
});

describe("redactValue", () => {
  it("recorre objetos y arrays sin romper la estructura", () => {
    const redacted = redactValue({
      email: "ops@example.com",
      nested: { client_ip: "198.51.100.7", ok: true },
      attempts: [1, 2, "user@example.com"],
    }) as {
      email: string;
      nested: { client_ip: string; ok: boolean };
      attempts: Array<number | string>;
    };

    expect(redacted.email).toBe(REDACTION_MARKERS.email);
    expect(redacted.nested.client_ip).toBe(REDACTION_MARKERS.ipv4);
    expect(redacted.nested.ok).toBe(true);
    expect(redacted.attempts[2]).toBe(REDACTION_MARKERS.email);
  });
});
