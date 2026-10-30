import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

type Settings = {
  workspaceRoot?: string;
  /** Tabs the user chose to hide (see TOGGLEABLE_TABS). Absent = the defaults below. */
  hiddenTabs?: string[];
};

// Chat, Conversations and Settings are always there. The others can be hidden: that is a view
// preference, nothing is removed, so the fork stays easy to sync with upstream.
export const TOGGLEABLE_TABS = ["todos", "marketing", "skills", "summary", "insights"] as const;
const DEFAULT_HIDDEN_TABS = ["marketing", "summary", "insights"];

const dataDir = join(homedir(), ".overlord");
const settingsPath = join(dataDir, "settings.json");
const fallbackWorkspaceRoot = process.env.OVERLORD_ROOT || resolve(process.cwd(), "..");

function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function getWorkspaceRoot() {
  return readSettings().workspaceRoot || fallbackWorkspaceRoot;
}

export function getWorkspaceSettings() {
  const settings = readSettings();
  const envConfigured = Boolean(process.env.OVERLORD_ROOT);
  const savedPath = settings.workspaceRoot;

  return {
    path: savedPath || fallbackWorkspaceRoot,
    configured: Boolean(savedPath || envConfigured),
    source: savedPath ? "user" : envConfigured ? "env" : "default",
  };
}

export function setWorkspaceRoot(path: string) {
  const trimmedPath = path.trim();

  if (!trimmedPath) {
    throw new Error("Path required");
  }

  const workspaceRoot = resolve(trimmedPath);
  if (!existsSync(workspaceRoot)) {
    throw new Error("Directory not found");
  }
  if (!statSync(workspaceRoot).isDirectory()) {
    throw new Error("Path must be a directory");
  }

  writeSettings({ ...readSettings(), workspaceRoot });
  return getWorkspaceSettings();
}

const isToggleableTab = (tab: unknown): tab is (typeof TOGGLEABLE_TABS)[number] =>
  typeof tab === "string" && (TOGGLEABLE_TABS as readonly string[]).includes(tab);

export function getHiddenTabs(): string[] {
  const saved = readSettings().hiddenTabs;
  return Array.isArray(saved) ? saved.filter(isToggleableTab) : DEFAULT_HIDDEN_TABS;
}

export function setHiddenTabs(tabs: unknown): string[] {
  if (!Array.isArray(tabs)) throw new Error("hidden must be an array of tab names");
  const hidden = [...new Set(tabs.filter(isToggleableTab))];
  writeSettings({ ...readSettings(), hiddenTabs: hidden });
  return hidden;
}

/**
 * The project summary and the "learnings" are only shown in the Summary tab and each one costs an extra
 * Claude call after a turn. With that tab hidden nobody reads them, so they are not generated.
 */
export function isSummaryEnabled(): boolean {
  return !getHiddenTabs().includes("summary");
}
