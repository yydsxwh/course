/** 后台展示用脱敏，避免完整邮箱/手机下发到普通列表。 */

export function maskEmail(email: string | null | undefined): string {
  const value = (email || "").trim();
  if (!value || !value.includes("@")) return "";
  const [name, domain] = value.split("@");
  if (!name) return `*@${domain}`;
  if (name.length === 1) return `${name}***@${domain}`;
  return `${name.slice(0, 1)}***${name.slice(-1)}@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 4) return digits ? "****" : "";
  return `****${digits.slice(-4)}`;
}

export function maskName(name: string | null | undefined): string {
  const value = (name || "").trim();
  if (!value) return "";
  if (value.length === 1) return `${value}*`;
  return `${value.slice(0, 1)}*${value.slice(-1)}`;
}
