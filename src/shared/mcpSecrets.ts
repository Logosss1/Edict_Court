// Which mcp.json values are moved into the system keychain on save (main process) — shared so the settings
// page can tell the user, before saving, which header / env values would otherwise be written as plain text.
export const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential|cookie|bearer)/i;
export const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|glpat-|AKIA|AIza|Bearer\s+\S{12,}|Basic\s+\S{8,})/;

/** True when saving `key: value` (env / headers) stores the value in the keychain and leaves `${secret:…}` in mcp.json. */
export function movesToKeychain(key: string, value: string): boolean {
  return !!value && !value.includes('${') && (SECRET_NAME.test(key) || SECRET_VALUE.test(value));
}
