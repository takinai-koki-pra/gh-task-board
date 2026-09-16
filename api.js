// GitHub REST API の薄いラッパー。ブラウザから直接呼ぶ（バックエンド不要）。
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class GitHubApi {
  constructor({ token, repo }) {
    this.token = token;
    this.repo = repo; // "owner/name"
  }

  async request(path, { method = "GET", body, query } = {}) {
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return { data: null, res };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || `${res.status} ${res.statusText}`;
      throw new GitHubError(msg, res.status, data);
    }
    return { data, res };
  }

  async getRepo() {
    const { data } = await this.request(`/repos/${this.repo}`);
    return data;
  }

  // Issues を全ページ取得する（PR は除外）。最大 maxPages ページ。
  async listIssues({ maxPages = 5 } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, res } = await this.request(`/repos/${this.repo}/issues`, {
        query: { state: "all", per_page: "100", page: String(page), sort: "updated", direction: "desc" },
      });
      for (const it of data) if (!it.pull_request) all.push(it);
      const link = res.headers.get("Link") || "";
      if (!/rel="next"/.test(link)) break;
    }
    return all;
  }

  async createIssue({ title, body = "", labels = [] }) {
    const { data } = await this.request(`/repos/${this.repo}/issues`, {
      method: "POST",
      body: { title, body, labels },
    });
    return data;
  }

  async updateIssue(number, patch) {
    const { data } = await this.request(`/repos/${this.repo}/issues/${number}`, {
      method: "PATCH",
      body: patch,
    });
    return data;
  }

  async listLabels() {
    const { data } = await this.request(`/repos/${this.repo}/labels`, { query: { per_page: "100" } });
    return data;
  }

  // 必要なラベルが無ければ作る。
  async ensureLabels(defs) {
    const existing = new Set((await this.listLabels()).map((l) => l.name));
    const created = [];
    for (const def of defs) {
      if (existing.has(def.name)) continue;
      await this.request(`/repos/${this.repo}/labels`, { method: "POST", body: def });
      created.push(def.name);
    }
    return created;
  }
}

// デモ用: ネットワークを使わず、メモリ内で同じインターフェースを提供する。
export class DemoApi {
  constructor(issues) {
    this.issues = issues;
    this.repo = "demo/tasks";
    this.nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
  }
  async getRepo() { return { full_name: this.repo, private: true }; }
  async listIssues() { return structuredClone(this.issues); }
  async createIssue({ title, body = "", labels = [] }) {
    const now = new Date().toISOString();
    const issue = {
      number: this.nextNumber++, title, body, state: "open",
      labels: labels.map((name) => ({ name, color: "888888" })),
      html_url: "#", created_at: now, updated_at: now,
    };
    this.issues.unshift(issue);
    return structuredClone(issue);
  }
  async updateIssue(number, patch) {
    const issue = this.issues.find((i) => i.number === number);
    if (!issue) throw new GitHubError("Not Found", 404);
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.labels !== undefined) issue.labels = patch.labels.map((name) => ({ name, color: "888888" }));
    issue.updated_at = new Date().toISOString();
    return structuredClone(issue);
  }
  async listLabels() { return []; }
  async ensureLabels() { return []; }
}
