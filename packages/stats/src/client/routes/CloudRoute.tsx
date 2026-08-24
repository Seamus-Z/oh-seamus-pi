import { Check, Cloud, CloudDownload, Link2, LogOut, Mail, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	type CloudSessionSummary,
	connectSyncServer,
	disconnectSyncServer,
	forgotSyncPassword,
	getSyncConnection,
	listCloudSessions,
	type PullResult,
	pullCloudSession,
	type SyncConnection,
} from "../manager-api";

interface CloudRouteProps {
	active: boolean;
}

function relativeTime(value: string): string {
	const elapsed = Date.now() - Date.parse(value);
	if (elapsed < 60_000) return "just now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
	if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
	return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function fileSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CloudRoute({ active }: CloudRouteProps) {
	const [connection, setConnection] = useState<SyncConnection>();
	const [sessions, setSessions] = useState<CloudSessionSummary[]>([]);
	const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3850");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [email, setEmail] = useState("");
	const [forgotMode, setForgotMode] = useState(false);
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [pulling, setPulling] = useState<string>();
	const [pullResult, setPullResult] = useState<PullResult>();
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(async () => {
		setError("");
		try {
			const current = await getSyncConnection();
			setConnection(current);
			if (current.connected) setSessions(await listCloudSessions());
			else setSessions([]);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		if (active) void refresh();
	}, [active, refresh]);

	const connect = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const current = await connectSyncServer(baseUrl, username, password, email || undefined);
			setConnection(current);
			setPassword("");
			setSessions(await listCloudSessions());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const sendReset = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await forgotSyncPassword(baseUrl, username, email);
			setNotice("If the cloud account and email match, a reset link has been sent.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const disconnect = async () => {
		await disconnectSyncServer();
		setConnection({ connected: false });
		setSessions([]);
	};

	const pull = async (session: CloudSessionSummary) => {
		setPulling(session.id);
		setError("");
		try {
			setPullResult(
				await pullCloudSession(session.id, session.latestVersion, connection?.terminalConnected === true),
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPulling(undefined);
		}
	};

	const copyResume = async () => {
		if (!pullResult) return;
		await navigator.clipboard.writeText(pullResult.resumeCommand);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	};

	if (!connection?.connected) {
		return (
			<div className="manager-cloud-page">
				<section className="manager-cloud-connect">
					<div className="manager-cloud-emblem">
						<Cloud size={28} />
					</div>
					<span className="manager-kicker">
						<span /> SESSION SYNC UPLINK
					</span>
					<h2>Connect your sync server</h2>
					<p>Use loopback HTTP while testing locally. Production servers must use HTTPS.</p>
					<form onSubmit={forgotMode ? sendReset : connect}>
						<label>
							<span>Server URL</span>
							<div>
								<Server size={16} />
								<input
									value={baseUrl}
									onChange={event => setBaseUrl(event.target.value)}
									placeholder="https://sync.example.com"
									required
								/>
							</div>
						</label>
						<label>
							<span>Username</span>
							<div>
								<ShieldCheck size={16} />
								<input
									value={username}
									onChange={event => setUsername(event.target.value)}
									autoComplete="username"
									required
								/>
							</div>
						</label>
						<label>
							<span>Recovery email {forgotMode ? "" : "(required on first setup)"}</span>
							<div>
								<Mail size={16} />
								<input
									type="email"
									value={email}
									onChange={event => setEmail(event.target.value)}
									autoComplete="email"
									required={forgotMode}
									placeholder="you@example.com"
								/>
							</div>
						</label>
						{!forgotMode && (
							<label>
								<span>Password</span>
								<div>
									<Link2 size={16} />
									<input
										type="password"
										value={password}
										onChange={event => setPassword(event.target.value)}
										autoComplete="current-password"
										minLength={10}
										required
									/>
								</div>
							</label>
						)}
						{notice && (
							<div className="manager-upload-notice">
								<Check size={15} />
								{notice}
							</div>
						)}
						{error && <div className="manager-inline-error">{error}</div>}
						<button type="submit" disabled={busy}>
							{busy ? (
								<RefreshCw className="manager-spin" size={17} />
							) : forgotMode ? (
								<Mail size={17} />
							) : (
								<Cloud size={17} />
							)}
							{busy ? "Working…" : forgotMode ? "Send cloud reset link" : "Connect and sign in"}
						</button>
						<button
							type="button"
							className="manager-cloud-link"
							onClick={() => {
								setForgotMode(value => !value);
								setError("");
								setNotice("");
							}}
						>
							{forgotMode ? "Back to cloud sign in" : "Forgot cloud password?"}
						</button>
					</form>
					<small>
						If the server has no users, this first login creates its administrator account and binds the recovery
						email.
					</small>
				</section>
			</div>
		);
	}

	return (
		<div className="manager-cloud-page">
			<section className="manager-cloud-hero">
				<div>
					<span className="manager-kicker">
						<span /> CLOUD VAULT CONNECTED
					</span>
					<h2>Synced conversations</h2>
					<p>
						{connection.username} · {connection.baseUrl}
					</p>
				</div>
				<div className="manager-hero-actions">
					<button
						type="button"
						className="manager-icon-button"
						onClick={() => void refresh()}
						title="Refresh cloud sessions"
					>
						<RefreshCw size={17} />
					</button>
					<button
						type="button"
						className="manager-icon-button"
						onClick={() => void disconnect()}
						title="Disconnect sync server"
					>
						<LogOut size={17} />
					</button>
				</div>
			</section>
			<div className={`manager-terminal-link ${connection.terminalConnected ? "manager-terminal-link-live" : ""}`}>
				<span />
				{connection.terminalConnected
					? "Live OMP terminal connected — downloaded sessions open automatically"
					: "No live OMP terminal — sessions download without switching a terminal"}
			</div>
			{error && <div className="manager-inline-error">{error}</div>}
			{pullResult && (
				<section className="manager-pull-result">
					<Check size={20} />
					<div>
						<strong>
							{pullResult.activationRequested
								? "Session opened in the connected terminal"
								: "Session downloaded"}
						</strong>
						<code>{pullResult.resumeCommand}</code>
					</div>
					<button type="button" onClick={() => void copyResume()}>
						{copied ? "Copied" : "Copy resume command"}
					</button>
				</section>
			)}
			<section className="manager-cloud-grid">
				{sessions.length === 0 && (
					<div className="manager-empty manager-cloud-empty">
						<Cloud size={30} />
						<strong>No cloud sessions yet</strong>
						<span>Open Local Sessions and upload one.</span>
					</div>
				)}
				{sessions.map(session => (
					<article className="manager-cloud-card" key={session.id}>
						<div className="manager-cloud-card-top">
							<span>V{session.latestVersion}</span>
							<small>{relativeTime(session.updatedAt)}</small>
						</div>
						<h3>{session.title}</h3>
						<p>{session.cwd || "Unknown workspace"}</p>
						<div className="manager-cloud-meta">
							<span>{session.deviceName}</span>
							<span>{fileSize(session.size)}</span>
						</div>
						<button type="button" disabled={pulling === session.id} onClick={() => void pull(session)}>
							<CloudDownload size={16} />
							{pulling === session.id
								? "Downloading…"
								: connection.terminalConnected
									? "Download & open in terminal"
									: "Download to this machine"}
						</button>
					</article>
				))}
			</section>
		</div>
	);
}
