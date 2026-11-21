const STORAGE_KEY = "beacon.token";

/**
 * El bearer de la API vive en el `localStorage` del navegador.
 *
 * Es un token de servicio local, no una credencial de usuario: la UI lo pide una vez
 * para que la demo local funcione sin montar un login. En una instancia pública esto
 * sería el token del visitante, nunca el de un tercero.
 */
export function readToken(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Sin almacenamiento (modo privado) la UI funciona solo en memoria.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nada que limpiar.
  }
}
