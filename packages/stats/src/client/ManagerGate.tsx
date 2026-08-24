import { ArrowLeft, KeyRound, LockKeyhole, Mail, Orbit, ShieldCheck, Sparkles } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import {
	forgotManagerPassword,
	getManagerStatus,
	loginManager,
	type ManagerStatus,
	resetManagerPassword,
	setupManager,
} from "./manager-api";

interface ManagerGateProps {
	children: React.ReactNode;
}

type AuthMode = "login" | "forgot" | "reset";

function resetTokenFromHash(): string | undefined {
	if (!window.location.hash.startsWith("#/reset-password")) return undefined;
	return new URLSearchParams(window.location.hash.split("?", 2)[1] ?? "").get("token") ?? undefined;
}

export function ManagerGate({ children }: ManagerGateProps) {
	const [status, setStatus] = useState<ManagerStatus | undefined>();
	const [managerEnabled, setManagerEnabled] = useState<boolean | undefined>();
	const [mode, setMode] = useState<AuthMode>(resetTokenFromHash() ? "reset" : "login");
	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		getManagerStatus()
			.then(result => {
				setManagerEnabled(result !== undefined);
				setStatus(result);
			})
			.catch(err => {
				setManagerEnabled(true);
				setError(err instanceof Error ? err.message : String(err));
			});
	}, []);

	if (managerEnabled === false) return children;
	if (managerEnabled === undefined || !status) {
		return (
			<div className="manager-auth-shell">
				<div className="manager-auth-loader" aria-label="Connecting to OMP Manager">
					<Orbit size={30} />
					<span>Establishing local link</span>
				</div>
			</div>
		);
	}
	if (status.authenticated && mode !== "reset") return children;

	const submitLogin = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const next = status.setupRequired
				? await setupManager(username, email, password)
				: await loginManager(username, password);
			setStatus(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const submitForgot = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		setMessage("");
		try {
			await forgotManagerPassword(username, email);
			setMessage("If the account and email match, a reset link has been sent. Check your inbox.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const submitReset = async (event: React.FormEvent) => {
		event.preventDefault();
		if (password !== confirmPassword) {
			setError("Passwords do not match");
			return;
		}
		const token = resetTokenFromHash();
		if (!token) {
			setError("Reset link is missing its token");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await resetManagerPassword(token, password);
			window.location.hash = "#/sessions";
			setPassword("");
			setConfirmPassword("");
			setMessage("Password updated. Sign in with your new password.");
			setMode("login");
			setStatus(await getManagerStatus());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const resetMode = () => {
		setMode("login");
		setError("");
		setMessage("");
	};

	return (
		<div className="manager-auth-shell">
			<div className="manager-auth-orb manager-auth-orb-a" />
			<div className="manager-auth-orb manager-auth-orb-b" />
			<section className="manager-auth-card">
				<div className="manager-auth-brand">
					<div className="manager-auth-mark">
						<Sparkles size={22} />
					</div>
					<div>
						<strong>OMP · NEXUS</strong>
						<span>LOCAL SESSION CONTROL</span>
					</div>
				</div>
				<div className="manager-auth-copy">
					<div className="manager-auth-eyebrow">
						<ShieldCheck size={14} /> LOOPBACK SECURED
					</div>
					<h1>
						{mode === "forgot"
							? "Recover local access"
							: mode === "reset"
								? "Choose a new command key"
								: status.setupRequired
									? "Create your command key"
									: "Welcome back, operator"}
					</h1>
					<p>
						{mode === "forgot"
							? "Enter the operator ID and bound recovery email."
							: mode === "reset"
								? "Reset links are single-use and expire after 30 minutes."
								: status.setupRequired
									? "Create the first local administrator and bind a recovery email."
									: "Authenticate to inspect and resume your local OMP conversations."}
					</p>
				</div>

				{mode === "login" && (
					<form onSubmit={submitLogin} className="manager-auth-form">
						<label>
							<span>Operator ID</span>
							<input
								autoComplete="username"
								value={username}
								onChange={event => setUsername(event.target.value)}
								placeholder="local-admin"
								required
								minLength={3}
							/>
						</label>
						{status.setupRequired && (
							<label>
								<span>Recovery email</span>
								<input
									type="email"
									autoComplete="email"
									value={email}
									onChange={event => setEmail(event.target.value)}
									placeholder="you@example.com"
									required
								/>
							</label>
						)}
						<label>
							<span>Passphrase</span>
							<input
								type="password"
								autoComplete={status.setupRequired ? "new-password" : "current-password"}
								value={password}
								onChange={event => setPassword(event.target.value)}
								placeholder="10+ characters"
								required
								minLength={10}
							/>
						</label>
						{message && <div className="manager-auth-success">{message}</div>}
						{error && <div className="manager-auth-error">{error}</div>}
						<button type="submit" disabled={busy}>
							<LockKeyhole size={17} />
							{busy ? "Negotiating…" : status.setupRequired ? "Initialize local access" : "Enter Nexus"}
						</button>
						{!status.setupRequired && (
							<button
								type="button"
								className="manager-auth-link"
								onClick={() => {
									setMode("forgot");
									setError("");
									setMessage("");
								}}
							>
								<Mail size={14} /> Forgot password?
							</button>
						)}
					</form>
				)}

				{mode === "forgot" && (
					<form onSubmit={submitForgot} className="manager-auth-form">
						<label>
							<span>Operator ID</span>
							<input
								autoComplete="username"
								value={username}
								onChange={event => setUsername(event.target.value)}
								required
								minLength={3}
							/>
						</label>
						<label>
							<span>Recovery email</span>
							<input
								type="email"
								autoComplete="email"
								value={email}
								onChange={event => setEmail(event.target.value)}
								required
							/>
						</label>
						{!status.emailConfigured && (
							<div className="manager-auth-error">
								Email delivery is not configured. Set RESEND_API_KEY and OMP_MAIL_FROM, then restart Manager.
							</div>
						)}
						{message && <div className="manager-auth-success">{message}</div>}
						{error && <div className="manager-auth-error">{error}</div>}
						<button type="submit" disabled={busy || !status.emailConfigured}>
							<Mail size={17} />
							{busy ? "Sending…" : "Send reset link"}
						</button>
						<button type="button" className="manager-auth-link" onClick={resetMode}>
							<ArrowLeft size={14} /> Back to sign in
						</button>
					</form>
				)}

				{mode === "reset" && (
					<form onSubmit={submitReset} className="manager-auth-form">
						<label>
							<span>New passphrase</span>
							<input
								type="password"
								autoComplete="new-password"
								value={password}
								onChange={event => setPassword(event.target.value)}
								required
								minLength={10}
							/>
						</label>
						<label>
							<span>Confirm passphrase</span>
							<input
								type="password"
								autoComplete="new-password"
								value={confirmPassword}
								onChange={event => setConfirmPassword(event.target.value)}
								required
								minLength={10}
							/>
						</label>
						{error && <div className="manager-auth-error">{error}</div>}
						<button type="submit" disabled={busy}>
							<KeyRound size={17} />
							{busy ? "Updating…" : "Reset password"}
						</button>
						<button type="button" className="manager-auth-link" onClick={resetMode}>
							<ArrowLeft size={14} /> Back to sign in
						</button>
					</form>
				)}
				<footer>
					<span className="manager-live-dot" /> 127.0.0.1 · encrypted credential store
				</footer>
			</section>
		</div>
	);
}
