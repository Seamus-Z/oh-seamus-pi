import {
	Check,
	ChevronRight,
	Clock3,
	CloudUpload,
	Copy,
	Folder,
	LogOut,
	MessageSquare,
	Search,
	Terminal,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	getManagerSession,
	listManagerSessions,
	logoutManager,
	type ManagerSessionDetail,
	type ManagerSessionSummary,
	uploadManagerSession,
} from "../manager-api";

interface SessionsRouteProps {
	active: boolean;
}

function relativeTime(value: string): string {
	const elapsed = Date.now() - Date.parse(value);
	if (elapsed < 60_000) return "just now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
	if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
	if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
	return new Date(value).toLocaleDateString();
}

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SessionsRoute({ active }: SessionsRouteProps) {
	const [sessions, setSessions] = useState<ManagerSessionSummary[]>([]);
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<ManagerSessionDetail>();
	const [loading, setLoading] = useState(true);
	const [detailLoading, setDetailLoading] = useState(false);
	const [error, setError] = useState("");
	const [copied, setCopied] = useState(false);
	const [uploading, setUploading] = useState<string>();
	const [uploadNotice, setUploadNotice] = useState("");

	const refresh = useCallback(async (query: string) => {
		setLoading(true);
		setError("");
		try {
			setSessions(await listManagerSessions(query));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!active) return;
		const timer = window.setTimeout(() => void refresh(search), 180);
		return () => window.clearTimeout(timer);
	}, [active, refresh, search]);

	const openSession = async (id: string) => {
		setDetailLoading(true);
		setError("");
		try {
			setSelected(await getManagerSession(id));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setDetailLoading(false);
		}
	};

	const copyResume = async () => {
		if (!selected) return;
		await navigator.clipboard.writeText(selected.resumeCommand);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	};

	const upload = async (id: string) => {
		setUploading(id);
		setError("");
		setUploadNotice("");
		try {
			const result = await uploadManagerSession(id);
			setUploadNotice(
				result.unchanged ? "Cloud copy is already current." : `Uploaded cloud version ${result.version}.`,
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setUploading(undefined);
		}
	};

	const logout = async () => {
		await logoutManager();
		window.location.reload();
	};

	return (
		<div className="manager-sessions-page">
			<section className="manager-hero">
				<div>
					<span className="manager-kicker">
						<span /> LOCAL CONTEXT MATRIX
					</span>
					<h2>Conversation Nexus</h2>
					<p>Inspect every local OMP thread and jump back into the exact working context.</p>
				</div>
				<div className="manager-hero-actions">
					<div className="manager-node-status">
						<span /> NODE ONLINE
					</div>
					<button type="button" onClick={logout} className="manager-icon-button" title="Sign out">
						<LogOut size={17} />
					</button>
				</div>
			</section>

			<div className="manager-stat-grid">
				<div className="manager-stat-card">
					<MessageSquare size={18} />
					<span>SESSIONS</span>
					<strong>{sessions.length}</strong>
				</div>
				<div className="manager-stat-card">
					<Clock3 size={18} />
					<span>LATEST PULSE</span>
					<strong>{sessions[0] ? relativeTime(sessions[0].modifiedAt) : "—"}</strong>
				</div>
				<div className="manager-stat-card">
					<Terminal size={18} />
					<span>ACCESS MODE</span>
					<strong>LOCAL</strong>
				</div>
			</div>

			<section className="manager-session-panel">
				<div className="manager-panel-head">
					<div>
						<h3>Session archive</h3>
						<span>{loading ? "Scanning local context…" : `${sessions.length} indexed threads`}</span>
					</div>
					<label className="manager-search">
						<Search size={16} />
						<input
							value={search}
							onChange={event => setSearch(event.target.value)}
							placeholder="Search title, prompt, or path"
						/>
					</label>
				</div>
				{error && <div className="manager-inline-error">{error}</div>}
				{uploadNotice && (
					<div className="manager-upload-notice">
						<Check size={15} />
						{uploadNotice}
					</div>
				)}
				<div className="manager-session-list">
					{loading &&
						sessions.length === 0 &&
						Array.from({ length: 5 }, (_, index) => <div className="manager-session-skeleton" key={index} />)}
					{!loading && sessions.length === 0 && (
						<div className="manager-empty">
							<MessageSquare size={28} />
							<strong>No sessions found</strong>
							<span>Start an OMP conversation or adjust your search.</span>
						</div>
					)}
					{sessions.map(session => (
						<div className="manager-session-row" key={session.id}>
							<button
								type="button"
								className="manager-session-open"
								onClick={() => void openSession(session.id)}
							>
								<div className="manager-session-sigil">{session.title.slice(0, 1).toUpperCase()}</div>
								<div className="manager-session-main">
									<strong>{session.title}</strong>
									<p>{session.preview || "No user prompt preview"}</p>
									<span>
										<Folder size={13} />
										{session.cwd || "Unknown workspace"}
									</span>
								</div>
								<div className="manager-session-meta">
									<strong>{relativeTime(session.modifiedAt)}</strong>
									<span>{fileSize(session.size)}</span>
									<span>{session.messageCount}+ messages</span>
								</div>
								<ChevronRight size={18} />
							</button>
							<button
								type="button"
								className="manager-upload-button"
								disabled={uploading === session.id}
								onClick={() => void upload(session.id)}
								title="Upload this session to the sync server"
							>
								<CloudUpload size={16} />
								{uploading === session.id ? "Uploading" : "Upload"}
							</button>
						</div>
					))}
				</div>
			</section>

			{(selected || detailLoading) && (
				<div
					className="manager-detail-backdrop"
					onClick={() => !detailLoading && setSelected(undefined)}
					role="presentation"
				>
					<aside
						className="manager-detail-drawer"
						onClick={event => event.stopPropagation()}
						aria-label="Session transcript"
					>
						{detailLoading && !selected ? (
							<div className="manager-detail-loading">
								<span /> Loading transcript
							</div>
						) : (
							selected && (
								<>
									<header>
										<div>
											<span>SESSION · {selected.id.slice(0, 8)}</span>
											<h3>{selected.title}</h3>
											<p>{selected.cwd}</p>
										</div>
										<button type="button" onClick={() => setSelected(undefined)}>
											<X size={19} />
										</button>
									</header>
									<div className="manager-resume-box">
										<div>
											<Terminal size={15} />
											<code>{selected.resumeCommand}</code>
										</div>
										<button type="button" onClick={() => void copyResume()}>
											{copied ? <Check size={16} /> : <Copy size={16} />}
											{copied ? "Copied" : "Copy resume command"}
										</button>
									</div>
									{selected.truncated && (
										<div className="manager-truncated">
											Showing the latest {selected.messages.length} messages.
										</div>
									)}
									<div className="manager-transcript">
										{selected.messages.map(message => (
											<article
												className={`manager-message manager-message-${message.role}`}
												key={message.id}
											>
												<div>
													<span>{message.role}</span>
													{message.model && <small>{message.model}</small>}
												</div>
												<pre>{message.text}</pre>
											</article>
										))}
									</div>
								</>
							)
						)}
					</aside>
				</div>
			)}
		</div>
	);
}
