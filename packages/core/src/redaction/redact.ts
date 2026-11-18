/**
 * Redacción de secretos y PII (docs/plan.md §4.7).
 *
 * La política completa vive en el gateway, pero las tools también redactan antes de
 * devolver datos: una línea de log con un token no debe llegar al modelo aunque el
 * gateway todavía no exista. Hay una sola implementación para que no haya dos
 * definiciones de "secreto" que se desincronicen.
 *
 * Las marcas son estables y contables: los evals pueden afirmar que hubo redacción
 * sin mirar el contenido original.
 */

export const REDACTION_MARKERS = {
  email: "[redacted:email]",
  ipv4: "[redacted:ip]",
  ipv6: "[redacted:ip]",
  token: "[redacted:token]",
  secret: "[redacted:secret]",
  awsKey: "[redacted:aws-key]",
  jwt: "[redacted:jwt]",
} as const;

interface RedactionRule {
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

const RULES: readonly RedactionRule[] = [
  {
    // Claves de acceso de AWS antes que la regla de asignación genérica.
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: REDACTION_MARKERS.awsKey,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: REDACTION_MARKERS.jwt,
  },
  {
    // "Authorization: Bearer <token>" conserva la cabecera y tapa el valor.
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: (_match, prefix) => `${prefix}${REDACTION_MARKERS.token}`,
  },
  {
    // password=..., api_key: ..., token -> ...
    pattern:
      /\b([A-Za-z_]*(?:password|passwd|secret|api[_-]?key|token|authorization)[A-Za-z_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replacement: (_match, key, separator) => `${key}${separator}${REDACTION_MARKERS.secret}`,
  },
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: REDACTION_MARKERS.email,
  },
  {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: REDACTION_MARKERS.ipv4,
  },
  {
    // IPv6 con al menos dos grupos para no comerse "12:30" ni hashes sueltos.
    pattern: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi,
    replacement: REDACTION_MARKERS.ipv6,
  },
];

export interface RedactedText {
  text: string;
  redactions: number;
}

/** Redacta un texto y cuenta cuántas marcas aplicó. */
export function redactText(input: string): RedactedText {
  let text = input;
  let redactions = 0;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      redactions += 1;
      if (typeof rule.replacement === "function") {
        const match = String(args[0] ?? "");
        const groups = args.slice(1, -2).map((group) => String(group ?? ""));
        return rule.replacement(match, ...groups);
      }
      return rule.replacement;
    });
  }

  return { text, redactions };
}

/**
 * Redacta recursivamente un valor JSON (campos estructurados de un log). Se recorre
 * en vez de redactar el JSON serializado para no romper claves ni comillas.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redactText(key).text,
      redactValue(item),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}
