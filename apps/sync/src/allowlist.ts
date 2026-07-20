/**
 * 招待制 allowlist。`ALLOWED_EMAILS` (カンマ区切り) に一致するメールアドレスだけ
 * 連携を許可する。空文字列・未設定なら全許可 (allowlist 無効)。
 */
export function isEmailAllowed(allowedEmailsCsv: string | undefined, email: string): boolean {
  const allowed = parseAllowedEmails(allowedEmailsCsv);
  if (allowed.length === 0) return true;
  return allowed.includes(normalizeEmail(email));
}

function parseAllowedEmails(csv: string | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((entry) => normalizeEmail(entry))
    .filter((entry) => entry.length > 0);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
