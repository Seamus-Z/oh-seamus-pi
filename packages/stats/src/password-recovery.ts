const DEFAULT_RESEND_API_URL = "https://api.resend.com/emails";

export const PASSWORD_RESET_TTL_MS = 1000 * 60 * 30;

export function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const email = value.trim().toLowerCase();
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
	return email;
}

export function recoveryEmailConfigured(): boolean {
	return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.OMP_MAIL_FROM?.trim());
}

export async function hashRecoveryToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Buffer.from(digest).toString("hex");
}

export async function sendPasswordResetEmail(options: {
	to: string;
	username: string;
	resetUrl: string;
	serviceName: string;
}): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY?.trim();
	const from = process.env.OMP_MAIL_FROM?.trim();
	if (!apiKey || !from) throw new Error("Email recovery is not configured on this server");
	const response = await fetch(process.env.RESEND_API_URL?.trim() || DEFAULT_RESEND_API_URL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			from,
			to: [options.to],
			subject: `Reset your ${options.serviceName} password`,
			text: [
				`A password reset was requested for ${options.username}.`,
				"",
				`Open this link within 30 minutes: ${options.resetUrl}`,
				"",
				"If you did not request this reset, ignore this email.",
			].join("\n"),
			html: `<p>A password reset was requested for <strong>${escapeHtml(options.username)}</strong>.</p><p><a href="${escapeHtml(options.resetUrl)}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request it, ignore this email.</p>`,
		}),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Resend rejected the message (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
	}
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
