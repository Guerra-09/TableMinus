import { homeDir, join } from "@tauri-apps/api/path";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SSH_PORT } from "../lib/constants";
import type { SshAuthMethod, SshConfig } from "../lib/types";

const SSH_AUTH_METHOD_LABELS: Record<SshAuthMethod, string> = {
  key: "Private key",
  password: "Password",
  agent: "SSH agent",
};

interface SshFieldsProps {
  ssh: SshConfig | null;
  secret: string;
  hasStoredSecret: boolean;
  onChange: (ssh: SshConfig | null) => void;
  onSecretChange: (secret: string) => void;
}

function createEmptySsh(): SshConfig {
  return { isEnabled: true, host: "", port: DEFAULT_SSH_PORT, user: "root", authMethod: "key", privateKeyPath: "" };
}

export function SshFields({ ssh, secret, hasStoredSecret, onChange, onSecretChange }: SshFieldsProps) {
  const isEnabled = ssh?.isEnabled ?? false;

  const updateSsh = (changes: Partial<SshConfig>) => onChange({ ...createEmptySsh(), ...ssh, ...changes });

  const choosePrivateKey = async () => {
    const sshDirectory = await homeDir()
      .then((home) => join(home, ".ssh"))
      .catch(() => undefined);
    const selectedPath = await openFileDialog({ multiple: false, directory: false, defaultPath: sshDirectory });
    if (typeof selectedPath === "string") updateSsh({ privateKeyPath: selectedPath });
  };

  const secretPlaceholder = hasStoredSecret ? "Stored in keychain" : ssh?.authMethod === "key" ? "Only if the key is encrypted" : "";

  return (
    <>
      <label>Over SSH</label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, textAlign: "left", color: "var(--color-text)" }}>
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => (event.target.checked ? updateSsh({ isEnabled: true }) : onChange(ssh ? { ...ssh, isEnabled: false } : null))}
        />
        Connect through an SSH tunnel
      </label>

      {isEnabled && ssh && (
        <>
          <label>SSH host / port</label>
          <div className="form-row-inline">
            <input value={ssh.host} placeholder="203.0.113.10 or my-vps.com" onChange={(event) => updateSsh({ host: event.target.value })} style={{ flex: 3 }} />
            <input type="number" value={ssh.port} onChange={(event) => updateSsh({ port: Number(event.target.value) })} style={{ flex: 1 }} />
          </div>

          <label>SSH user</label>
          <input value={ssh.user} onChange={(event) => updateSsh({ user: event.target.value })} />

          <label>Authentication</label>
          <select value={ssh.authMethod} onChange={(event) => updateSsh({ authMethod: event.target.value as SshAuthMethod })}>
            {(Object.keys(SSH_AUTH_METHOD_LABELS) as SshAuthMethod[]).map((authMethod) => (
              <option key={authMethod} value={authMethod}>
                {SSH_AUTH_METHOD_LABELS[authMethod]}
              </option>
            ))}
          </select>

          {ssh.authMethod === "key" && (
            <>
              <label>Private key</label>
              <div className="form-row-inline">
                <input
                  value={ssh.privateKeyPath}
                  placeholder="Default: ~/.ssh/id_ed25519, id_ecdsa or id_rsa"
                  onChange={(event) => updateSsh({ privateKeyPath: event.target.value })}
                  style={{ flex: 3 }}
                />
                <button className="btn" style={{ flex: "none" }} onClick={choosePrivateKey}>
                  Select…
                </button>
              </div>
            </>
          )}

          {ssh.authMethod !== "agent" && (
            <>
              <label>{ssh.authMethod === "key" ? "Passphrase" : "SSH password"}</label>
              <input type="password" value={secret} placeholder={secretPlaceholder} onChange={(event) => onSecretChange(event.target.value)} />
            </>
          )}

          <span />
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
            Host and port above are resolved from the SSH server, so use 127.0.0.1 when the database runs on the same
            machine. New server keys are trusted on first use and remembered; a changed key blocks the connection.
          </div>
        </>
      )}
    </>
  );
}
