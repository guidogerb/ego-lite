import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type Pending = { resolve(value: any): void; reject(error: Error): void };
type TaskSpace = { taskId: string; id: number; name: string; ownership: string };

const PORT = Number(process.env.EGO_BROWSER_DEBUG_PORT || 9333);
const HOST = `http://127.0.0.1:${PORT}`;

/** Install a local Chromium-backed ego bridge when the native app bridge is absent. */
export async function ensureLinuxEgoRuntime() {
  if ((globalThis as any).ego) return;
  if (process.platform !== "linux") return;
  const root = resolve(
    process.env.EGO_BROWSER_STATE_DIR ||
      join(dirname(process.argv[1] || process.cwd()), "..", "..", ".linux-runtime"),
  );
  await mkdir(root, { recursive: true });
  const wsUrl = await ensureChrome(root);
  (globalThis as any).ego = await LinuxEgoRuntime.connect(wsUrl, root);
}

async function ensureChrome(root: string) {
  const existing = await browserWebSocketUrl();
  if (existing) return existing;
  const executable = process.env.EGO_BROWSER_CHROMIUM || "/usr/bin/google-chrome";
  const logPath = join(root, "chrome.log");
  const log = await import("node:fs").then((fs) =>
    fs.openSync(logPath, "a"),
  );
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${join(root, "profile")}`,
      "--headless=new",
      "--disable-gpu-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,1000",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const url = await browserWebSocketUrl();
    if (url) return url;
  }
  throw new Error(`Chromium did not expose CDP on ${HOST}; see ${logPath}`);
}

async function browserWebSocketUrl(): Promise<string | null> {
  try {
    const response = await fetch(`${HOST}/json/version`);
    if (!response.ok) return null;
    return (await response.json()).webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

class LinuxEgoRuntime {
  onCDPMessage?: (message: string) => void;
  onSendCDPMessageError?: (message: string, code?: string) => void;
  private nextId = 100000;
  private pending = new Map<number, Pending>();
  private activeTarget: string | null = null;
  private tasks: TaskSpace[] = [];

  private constructor(
    private socket: WebSocket,
    private root: string,
  ) {}

  static async connect(wsUrl: string, root: string) {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
    });
    const runtime = new LinuxEgoRuntime(socket, root);
    socket.addEventListener("message", (event) => runtime.receive(String(event.data)));
    runtime.tasks = await runtime.loadTasks();
    return runtime;
  }

  sendCDPMessage = (payload: string) => {
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.onSendCDPMessageError?.("Chromium CDP connection is closed", "EGO_BROWSER_DISCONNECTED");
      return;
    }
    this.socket.send(payload);
  };

  private receive(message: string) {
    let parsed: any;
    try { parsed = JSON.parse(message); } catch { return; }
    const pending = parsed.id && this.pending.get(parsed.id);
    if (pending) {
      this.pending.delete(parsed.id);
      parsed.error ? pending.reject(new Error(parsed.error.message || String(parsed.error))) : pending.resolve(parsed.result || {});
      return;
    }
    this.onCDPMessage?.(message);
  }

  private command(method: string, params: any = {}, sessionId?: string) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP request timed out: ${method}`)); }, 15000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async listTabs() {
    const { targetInfos = [] } = await this.command("Target.getTargets");
    const pages = targetInfos.filter((target: any) => target.type === "page");
    if (!this.activeTarget || !pages.some((page: any) => page.targetId === this.activeTarget)) {
      this.activeTarget = pages.at(-1)?.targetId || null;
    }
    return { tabs: pages.map((page: any, index: number) => ({
      targetId: page.targetId, title: page.title || "", url: page.url || "",
      active: page.targetId === this.activeTarget, index,
    })) };
  }

  async createTab(url = "about:blank") {
    const result = await this.command("Target.createTarget", { url });
    this.activeTarget = result.targetId;
    return result;
  }

  async snapshot(_options: any = {}) {
    const { tabs } = await this.listTabs();
    const target = tabs.find((tab: any) => tab.active) || tabs[0];
    if (!target) return { content: "", refs: [] };
    const attached = await this.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const ax = await this.command("Accessibility.getFullAXTree", {}, attached.sessionId);
    await this.command("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
    const refs: any[] = [];
    const lines: string[] = [];
    for (const node of ax.nodes || []) {
      if (node.ignored || !node.backendDOMNodeId) continue;
      const role = node.role?.value || "generic";
      const name = node.name?.value || "";
      if (!name && !["textbox", "button", "slider", "listbox"].includes(role)) continue;
      const id = Number(node.backendDOMNodeId);
      refs.push({ backendNodeId: id, role, name });
      lines.push(`[ref=${id}, loc=role:${role}] ${role}${name ? ` ${JSON.stringify(name)}` : ""}`);
    }
    return { content: lines.join("\n"), refs };
  }

  async listTaskSpaces() { return { taskSpaces: this.tasks }; }
  async createTaskSpace(name: string) {
    const task = { taskId: name, id: Math.max(0, ...this.tasks.map((item) => item.id)) + 1, name, ownership: "agent" };
    this.tasks.push(task); await this.saveTasks(); return task;
  }
  async useTaskSpace(_id: number) { return { ok: true }; }
  async claimTaskSpace(id: number) { const task = this.tasks.find((item) => item.id === id); if (task) task.ownership = "agent"; await this.saveTasks(); return task; }
  async handOffTaskSpace() { return { ok: true }; }
  async takeOverTaskSpace() { return { ok: true }; }
  async completeTaskSpace() { return { ok: true }; }
  async closeTaskSpace() { this.tasks = []; await this.saveTasks(); return { ok: true }; }
  async getBrowserVersion() { return "ego-browser linux source build"; }
  disconnect() { this.socket.close(); }

  private async loadTasks(): Promise<TaskSpace[]> {
    try { return JSON.parse(await readFile(join(this.root, "tasks.json"), "utf8")); } catch { return []; }
  }
  private async saveTasks() {
    const path = join(this.root, "tasks.json");
    await writeFile(path, JSON.stringify(this.tasks, null, 2));
    await chmod(path, 0o600);
  }
}
