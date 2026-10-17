import { Fragment, type ReactNode } from "react";
import changelogMarkdown from "../../CHANGELOG.md?raw";
import { Modal } from "./Modal";

type ChangelogBlock =
  | { kind: "release"; text: string }
  | { kind: "section"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "item"; text: string; depth: number };

const LINK_REFERENCE_PATTERN = /^\[[^\]]+\]:\s/;
const INLINE_TOKEN_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function parseChangelog(markdown: string): ChangelogBlock[] {
  const blocks: ChangelogBlock[] = [];
  let hasReachedReleases = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      hasReachedReleases = true;
      const releaseTitle = line.slice(3).replace(/\[([^\]]+)\]/, "$1").trim();
      if (releaseTitle !== "Unreleased") blocks.push({ kind: "release", text: releaseTitle });
      continue;
    }
    if (!hasReachedReleases || line.trim() === "" || LINK_REFERENCE_PATTERN.test(line)) continue;
    if (line.startsWith("### ")) {
      blocks.push({ kind: "section", text: line.slice(4).trim() });
      continue;
    }
    const itemMatch = /^(\s*)- (.*)$/.exec(line);
    if (itemMatch) {
      blocks.push({ kind: "item", text: itemMatch[2], depth: Math.floor(itemMatch[1].length / 2) });
    } else {
      blocks.push({ kind: "paragraph", text: line.trim() });
    }
  }
  return blocks;
}

function renderInline(text: string): ReactNode {
  return text.split(INLINE_TOKEN_PATTERN).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

const CHANGELOG_BLOCKS = parseChangelog(changelogMarkdown);

interface ChangelogModalProps {
  appVersion: string;
  onClose: () => void;
}

export function ChangelogModal({ appVersion, onClose }: ChangelogModalProps) {
  return (
    <Modal
      title={`What's new — TableMinus ${appVersion}`}
      isWide
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="changelog">
        {CHANGELOG_BLOCKS.map((block, index) => {
          switch (block.kind) {
            case "release":
              return (
                <h3 key={index} className="changelog-release">
                  {block.text}
                  {block.text.startsWith(appVersion) && <span className="badge">Installed</span>}
                </h3>
              );
            case "section":
              return (
                <h4 key={index} className="changelog-section">
                  {block.text}
                </h4>
              );
            case "item":
              return (
                <div key={index} className="changelog-item" style={{ marginLeft: block.depth * 18 }}>
                  {renderInline(block.text)}
                </div>
              );
            default:
              return (
                <p key={index} className="changelog-paragraph">
                  {renderInline(block.text)}
                </p>
              );
          }
        })}
      </div>
    </Modal>
  );
}
