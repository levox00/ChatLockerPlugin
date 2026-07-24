/*
 * Equicord User Plugin: ChatLockButton
 *
 * Adds a "Lock Chat" item to the + (attachment) dropdown.
 * Shows a blur overlay when locked – persistent across restarts.
 * Auto‑locks when you switch away from a channel.
 * Uses DataStore (IndexedDB) for reliable persistence.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import definePlugin from "@utils/types";
import {
    SelectedChannelStore,
    Toasts,
    openModal,
    Modal,
    Menu,
    React,
    useState,
    PermissionStore,
    PermissionsBits,
} from "@webpack/common";

// ============================================================================
// DataStore-based storage (async, persistent across restarts)
// ============================================================================

const DATASTORE_KEY = "ChatLockButton_data";
const SALT = "ChatLockButton_2025_salt";

// In-memory cache for fast access
let settingsCache: Record<string, string> | null = null;
let settingsLoaded = false;

async function loadAll(): Promise<Record<string, string>> {
    if (settingsCache !== null) return settingsCache;
    try {
        const data = await DataStore.get(DATASTORE_KEY) as Record<string, string> | undefined;
        if (data && typeof data === "object") {
            settingsCache = data;
            settingsLoaded = true;
            return data;
        }
    } catch (e) {
        console.warn("[ChatLockButton] Failed to load from DataStore:", e);
    }
    settingsCache = {};
    settingsLoaded = true;
    return settingsCache;
}

async function saveAll(data: Record<string, string>) {
    settingsCache = data;
    try {
        await DataStore.set(DATASTORE_KEY, data);
    } catch (e) {
        console.warn("[ChatLockButton] Failed to save to DataStore:", e);
    }
}

async function getHash(id: string): Promise<string | null> {
    const data = await loadAll();
    return data[id] || null;
}

async function setHash(id: string, hash: string | null) {
    const data = await loadAll();
    if (hash) data[id] = hash;
    else delete data[id];
    await saveAll(data);
}

// ============================================================================
// Lock state (in-memory, cleared on restart)
// ============================================================================

const unlocked = new Set<string>();
const isUnlocked = (id: string) => unlocked.has(id);
const unlock = (id: string) => unlocked.add(id);
const lock = (id: string) => unlocked.delete(id);

const isLocked = (id: string): boolean => {
    // If we haven't loaded settings yet, assume not locked
    if (!settingsLoaded) return false;
    return settingsCache?.[id] !== undefined && !isUnlocked(id);
};

const getCurrentId = (): string | null => SelectedChannelStore.getChannelId();

// ============================================================================
// Lock SVG Icon
// ============================================================================

const LockIcon = () => (
    <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
    >
        <path
            fill="currentColor"
            fillRule="evenodd"
            d="M6 9h1V6a5 5 0 0 1 10 0v3h1a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3Zm9-3v3H9V6a3 3 0 1 1 6 0Zm-1 8a2 2 0 0 1-1 1.73V18a1 1 0 1 1-2 0v-2.27A2 2 0 1 1 14 14Z"
            clipRule="evenodd"
        />
    </svg>
);

// ============================================================================
// Modals
// ============================================================================

const inputStyle: React.CSSProperties = {
    padding: 8,
    borderRadius: 4,
    border: "1px solid var(--background-modifier-border)",
    background: "var(--input-background)",
    color: "var(--text-normal)",
    fontSize: 14,
};

function SetPasswordModal({ modalProps, channelId }: { modalProps: any; channelId: string }) {
    const [pwd, setPwd] = useState("");
    const [confirm, setConfirm] = useState("");
    const [err, setErr] = useState("");

    const submit = async () => {
        if (pwd.length < 4) return setErr("Min 4 characters");
        if (pwd !== confirm) return setErr("Passwords don't match");
        await setHash(channelId, await hashPassword(pwd));
        lock(channelId);
        Toasts.show({ type: Toasts.Type.SUCCESS, message: "🔒 Channel locked" });
        modalProps.onClose();
        refreshAll();
    };

    return (
        <Modal
            {...modalProps}
            title="🔒 Set Lock Password"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Set & Lock", variant: "primary", onClick: submit },
            ]}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input type="password" placeholder="New password (min 4 chars)" value={pwd}
                    onChange={e => setPwd(e.target.value)} autoFocus style={inputStyle} />
                <input type="password" placeholder="Confirm password" value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && submit()} style={inputStyle} />
                {err && <div style={{ color: "var(--text-danger)" }}>{err}</div>}
            </div>
        </Modal>
    );
}

function UnlockModal({ modalProps, channelId }: { modalProps: any; channelId: string }) {
    const [pwd, setPwd] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setBusy(true);
        const stored = await getHash(channelId);
        if (!stored) { setErr("No password set"); setBusy(false); return; }
        if ((await hashPassword(pwd)) === stored) {
            unlock(channelId);
            Toasts.show({ type: Toasts.Type.SUCCESS, message: "🔓 Unlocked" });
            modalProps.onClose();
            refreshAll();
        } else {
            setErr("Wrong password");
            setBusy(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            title="🔒 Enter Password"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: busy ? "Checking..." : "Unlock", variant: "primary", onClick: submit, disabled: busy },
            ]}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input type="password" placeholder="Password" value={pwd}
                    onChange={e => setPwd(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && submit()}
                    autoFocus style={inputStyle} />
                {err && <div style={{ color: "var(--text-danger)" }}>{err}</div>}
            </div>
        </Modal>
    );
}

function ChangePasswordModal({ modalProps, channelId }: { modalProps: any; channelId: string }) {
    const [old, setOld] = useState("");
    const [n, setN] = useState("");
    const [c, setC] = useState("");
    const [err, setErr] = useState("");

    const submit = async () => {
        if (n.length < 4) return setErr("Min 4 characters");
        if (n !== c) return setErr("New passwords don't match");
        const stored = await getHash(channelId);
        if (!stored || (await hashPassword(old)) !== stored) return setErr("Current password is wrong");
        await setHash(channelId, await hashPassword(n));
        Toasts.show({ type: Toasts.Type.SUCCESS, message: "🔑 Password changed" });
        modalProps.onClose();
        refreshAll();
    };

    return (
        <Modal
            {...modalProps}
            title="🔑 Change Password"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Change", variant: "primary", onClick: submit },
            ]}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input type="password" placeholder="Current password" value={old}
                    onChange={e => setOld(e.target.value)} autoFocus style={inputStyle} />
                <input type="password" placeholder="New password (min 4 chars)" value={n}
                    onChange={e => setN(e.target.value)} style={inputStyle} />
                <input type="password" placeholder="Confirm new password" value={c}
                    onChange={e => setC(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && submit()} style={inputStyle} />
                {err && <div style={{ color: "var(--text-danger)" }}>{err}</div>}
            </div>
        </Modal>
    );
}

// ============================================================================
// Hash function
// ============================================================================

async function hashPassword(password: string): Promise<string> {
    const data = new TextEncoder().encode(password + SALT);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

// ============================================================================
// Actions
// ============================================================================

function openModalWrap(render: (modalProps: any) => React.ReactElement) {
    openModal(modalProps => render(modalProps));
}

const actSetLock = () => {
    const id = getCurrentId();
    if (!id) return;
    openModalWrap(mp => <SetPasswordModal modalProps={mp} channelId={id} />);
};

const actUnlock = () => {
    const id = getCurrentId();
    if (!id) return;
    openModalWrap(mp => <UnlockModal modalProps={mp} channelId={id} />);
};

const actRelock = () => {
    const id = getCurrentId();
    if (!id) return;
    lock(id);
    Toasts.show({ type: Toasts.Type.INFO, message: "🔒 Locked" });
    refreshAll();
};

// ============================================================================
// Menu item label & icon
// ============================================================================

function getMenuItemProps() {
    const id = getCurrentId();
    if (!id) return { label: "Lock Chat", icon: LockIcon };

    const has = settingsCache?.[id] !== undefined;
    const locked = isLocked(id);

    if (!has) return { label: "Set Password", icon: LockIcon };
    else if (locked) return { label: "Unlock Chat", icon: LockIcon };
    else return { label: "Lock Chat", icon: LockIcon };
}

// ============================================================================
// Context Menu Patch
// ============================================================================

const channelAttachPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (channel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel)) return;
    if (children.some(child => child?.props?.id === "chatlock-button")) return;

    const { label, icon: Icon } = getMenuItemProps();

    children.splice(1, 0, (
        <Menu.MenuItem
            id="chatlock-button"
            label={label}
            iconLeft={Icon}
            action={() => {
                const id = getCurrentId();
                if (!id) return;
                const has = settingsCache?.[id] !== undefined;
                if (!has) actSetLock();
                else if (isLocked(id)) actUnlock();
                else actRelock();
            }}
        />
    ));
};

// ============================================================================
// Overlay – with persistent retry
// ============================================================================

let overlayElement: HTMLDivElement | null = null;
let overlayTimeout: ReturnType<typeof setTimeout> | null = null;
let overlayRetryInterval: ReturnType<typeof setInterval> | null = null;

function createOverlay() {
    let container = document.querySelector('[class*="messagesWrapper"]') as HTMLElement;
    if (!container) container = document.querySelector('[class*="chatContent"]') as HTMLElement;
    if (!container) {
        console.warn("[ChatLockButton] Chat container not found.");
        return null;
    }

    if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
    }

    // Ensure no clipping
    container.style.overflow = 'visible';
    container.style.borderRadius = '0';

    removeOverlay();

    const overlay = document.createElement("div");
    overlay.id = "chatlock-overlay";
    overlay.style.cssText = `
        position: absolute;
        inset: -40px;               /* large negative inset to push blur out */
        z-index: 100;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(40px);
        -webkit-backdrop-filter: blur(40px);
        border-radius: 0;
        pointer-events: auto;
        color: var(--text-normal);
        transition: opacity 0.2s;
        will-change: transform;     /* forces GPU rendering */
        box-shadow: 0 0 40px rgba(0, 0, 0, 0.6); /* masks any remaining edge artifact */
    `;

    const icon = document.createElement("div");
    icon.style.cssText = "font-size: 72px; line-height: 1;";
    icon.textContent = "🔒";

    const title = document.createElement("div");
    title.style.cssText = "font-size: 20px; font-weight: 700; color: var(--text-normal);";
    title.textContent = "This chat is locked";

    const subtitle = document.createElement("div");
    subtitle.style.cssText = "font-size: 14px; color: var(--text-muted);";
    subtitle.textContent = "Enter the password to unlock and view messages.";

    const button = document.createElement("button");
    button.textContent = "Unlock Chat";
    button.style.cssText = `
        margin-top: 12px;
        padding: 10px 24px;
        background: var(--brand-experiment);
        color: #fff;
        border: none;
        border-radius: 4px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
        pointer-events: auto;
    `;
    button.onmouseenter = () => button.style.background = "var(--brand-experiment-hover)";
    button.onmouseleave = () => button.style.background = "var(--brand-experiment)";
    button.onclick = () => {
        const id = getCurrentId();
        if (id && isLocked(id)) actUnlock();
    };

    overlay.appendChild(icon);
    overlay.appendChild(title);
    overlay.appendChild(subtitle);
    overlay.appendChild(button);

    container.appendChild(overlay);
    overlayElement = overlay;
    console.log("[ChatLockButton] Overlay created successfully.");
    return overlay;
}

function removeOverlay() {
    if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
    }
    document.querySelectorAll('#chatlock-overlay').forEach(el => el.remove());
}

function updateOverlay() {
    if (overlayTimeout) {
        clearTimeout(overlayTimeout);
        overlayTimeout = null;
    }

    const id = getCurrentId();
    if (!id) {
        removeOverlay();
        return;
    }

    if (isLocked(id)) {
        if (!overlayElement || !document.body.contains(overlayElement)) {
            const created = createOverlay();
            if (!created) {
                overlayTimeout = setTimeout(() => {
                    updateOverlay();
                }, 500);
            }
        }
    } else {
        removeOverlay();
    }
}

function startOverlayRetryLoop() {
    let attempts = 0;
    const maxAttempts = 20;
    if (overlayRetryInterval) clearInterval(overlayRetryInterval);
    overlayRetryInterval = setInterval(() => {
        attempts++;
        const id = getCurrentId();
        if (id && isLocked(id) && (!overlayElement || !document.body.contains(overlayElement))) {
            const created = createOverlay();
            if (created) {
                clearInterval(overlayRetryInterval);
                overlayRetryInterval = null;
            }
        } else if (attempts >= maxAttempts) {
            clearInterval(overlayRetryInterval);
            overlayRetryInterval = null;
            console.log("[ChatLockButton] Overlay retry loop stopped after 10 seconds.");
        }
    }, 500);
}

// ============================================================================
// Auto‑re‑lock on channel switch
// ============================================================================

let previousChannelId: string | null = null;

function handleChannelChange() {
    const newId = getCurrentId();

    if (previousChannelId && previousChannelId !== newId) {
        lock(previousChannelId);
    }

    previousChannelId = newId;
    refreshAll();
}

// ============================================================================
// Startup: load and lock all password-protected channels
// ============================================================================

async function startupLockAll() {
    const data = await loadAll();
    const keys = Object.keys(data);
    for (const channelId of keys) {
        lock(channelId);
    }
    console.log(`[ChatLockButton] Locked ${keys.length} stored channels on startup.`);
    if (keys.length > 0) {
        console.log("[ChatLockButton] Stored channel IDs:", keys);
    }
    return keys;
}

// ============================================================================
// Refresh function
// ============================================================================

function refreshAll() {
    updateOverlay();
}

// ============================================================================
// Plugin definition
// ============================================================================

export default definePlugin({
    name: "ChatLockButton",
    description: "Adds a 'Lock Chat' item to the + dropdown. Blurs the chat when locked, auto‑locks on channel switch, and persists lock state across restarts.",
    authors: [{ name: "You", id: 0n }],

    contextMenus: {
        "channel-attach": channelAttachPatch,
    },

    start() {
        // Load and lock all stored channels
        startupLockAll().then(() => {
            // After loading, attempt overlay creation
            setTimeout(() => {
                const id = getCurrentId();
                if (id && isLocked(id)) {
                    const created = createOverlay();
                    if (!created && !overlayRetryInterval) {
                        startOverlayRetryLoop();
                    }
                }
            }, 200);
        });

        this._unsubChannel = SelectedChannelStore.addChangeListener(() => {
            handleChannelChange();
        });

        this._observer = new MutationObserver(() => {
            const id = getCurrentId();
            if (id && isLocked(id) && (!overlayElement || !document.body.contains(overlayElement))) {
                const created = createOverlay();
                if (!created && !overlayRetryInterval) {
                    startOverlayRetryLoop();
                }
            }
            if (overlayElement && (!id || !isLocked(id))) {
                removeOverlay();
            }
        });
        this._observer.observe(document.body, { childList: true, subtree: true });

        previousChannelId = getCurrentId();

        // Final check after 2 seconds
        setTimeout(() => {
            refreshAll();
        }, 2000);
    },

    stop() {
        this._unsubChannel?.();
        this._observer?.disconnect();
        if (overlayRetryInterval) {
            clearInterval(overlayRetryInterval);
            overlayRetryInterval = null;
        }
        removeOverlay();
        if (overlayTimeout) clearTimeout(overlayTimeout);
        previousChannelId = null;
    },
});