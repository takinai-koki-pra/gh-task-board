// GitHub REST API の薄いラッパー。ブラウザから直接、または /gh プロキシ経由で呼ぶ。
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const issueNumberOf = (c) => Number(String(c.issue_url || "").split("/").pop());

export class GitHubApi {
  // base を指定すると（serve.py / Worker のプロキシ）、そこへ転送しトークンは付けない。
  constructor({ token, repo, base }) {
    this.token = token;
    this.repo = repo; // "owner/name"
    this.base = base || API;
    this.labelNames = null;
  }

  async request(path, { method = "GET", body, query } = {}) {
    const url = new URL(this.base + path, location.href);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
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

  async paged(path, query, maxPages) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, res } = await this.request(path, { query: { ...query, per_page: "100", page: String(page) } });
      all.push(...data);
      if (!/rel="next"/.test(res.headers.get("Link") || "")) break;
    }
    return all;
  }

  async getRepo() {
    const { data } = await this.request(`/repos/${this.repo}`);
    return data;
  }

  // Issues を取得する（PR は除外）。open は全部、closed は直近だけ。
  async listIssues() {
    const [open, closed] = await Promise.all([
      this.paged(`/repos/${this.repo}/issues`, { state: "open", sort: "updated", direction: "desc" }, 10),
      this.paged(`/repos/${this.repo}/issues`, { state: "closed", sort: "updated", direction: "desc" }, 1),
    ]);
    return [...open, ...closed].filter((it) => !it.pull_request);
  }

  // リポジトリ全体の直近コメント（受信箱の「報告:」判定用）。issue 番号 → コメント[]
  async listRecentComments({ since, maxPages = 3 } = {}) {
    const query = { sort: "updated", direction: "desc" };
    if (since) query.since = since;
    const list = await this.paged(`/repos/${this.repo}/issues/comments`, query, maxPages);
    const map = new Map();
    for (const c of list) {
      const n = issueNumberOf(c);
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(c);
    }
    return map;
  }

  async listComments(number) {
    return this.paged(`/repos/${this.repo}/issues/${number}/comments`, {}, 3);
  }

  async createComment(number, body) {
    const { data } = await this.request(`/repos/${this.repo}/issues/${number}/comments`, { method: "POST", body: { body } });
    return data;
  }

  async deleteComment(id) {
    await this.request(`/repos/${this.repo}/issues/comments/${id}`, { method: "DELETE" });
  }

  async createIssue({ title, body = "", labels = [] }) {
    await this.ensureLabels(labels);
    const { data } = await this.request(`/repos/${this.repo}/issues`, { method: "POST", body: { title, body, labels } });
    return data;
  }

  async updateIssue(number, patch) {
    if (patch.labels) await this.ensureLabels(patch.labels);
    const { data } = await this.request(`/repos/${this.repo}/issues/${number}`, { method: "PATCH", body: patch });
    return data;
  }

  async listLabels() {
    return this.paged(`/repos/${this.repo}/labels`, {}, 3);
  }

  // 無いラベルを作る。defFor(name) が null のラベルは GitHub の自動作成に任せる。
  async ensureLabels(names, defFor = this.defFor) {
    if (!names.length) return [];
    if (!this.labelNames) this.labelNames = new Set((await this.listLabels()).map((l) => l.name));
    const created = [];
    for (const name of names) {
      if (this.labelNames.has(name)) continue;
      const def = defFor?.(name);
      if (!def) continue;
      try {
        await this.request(`/repos/${this.repo}/labels`, { method: "POST", body: def });
        created.push(name);
      } catch (e) {
        if (e.status !== 422) throw e; // 422 = 既にある
      }
      this.labelNames.add(name);
    }
    return created;
  }
}

// デモ用: ネットワークを使わず、メモリ内で同じインターフェースを提供する。
export class DemoApi {
  constructor(data) {
    const { issues, comments = {} } = Array.isArray(data) ? { issues: data } : data;
    this.repo = "demo/tasks";
    this.issues = issues;
    this.comments = comments; // { "9": [comment, ...] }
    this.nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
    this.nextComment = 1000;
  }
  async getRepo() { return { full_name: this.repo, private: true }; }
  async listIssues() { return structuredClone(this.issues); }
  async listRecentComments() {
    return new Map(Object.entries(this.comments).map(([n, list]) => [Number(n), structuredClone(list)]));
  }
  async listComments(number) { return structuredClone(this.comments[number] || []); }
  async createComment(number, body) {
    const c = { id: this.nextComment++, body, user: { login: "you" }, created_at: new Date().toISOString(), issue_url: `demo/${number}`, html_url: "#" };
    (this.comments[number] ||= []).push(c);
    return structuredClone(c);
  }
  async deleteComment(id) {
    for (const list of Object.values(this.comments)) {
      const i = list.findIndex((c) => c.id === id);
      if (i >= 0) list.splice(i, 1);
    }
  }
  async createIssue({ title, body = "", labels = [] }) {
    const now = new Date().toISOString();
    const issue = {
      number: this.nextNumber++, title, body, state: "open", state_reason: null,
      labels: labels.map((name) => ({ name })), html_url: "#", created_at: now, updated_at: now,
    };
    this.issues.unshift(issue);
    return structuredClone(issue);
  }
  async updateIssue(number, patch) {
    const issue = this.issues.find((i) => i.number === number);
    if (!issue) throw new GitHubError("Not Found", 404);
    for (const k of ["title", "body", "state"]) if (patch[k] !== undefined) issue[k] = patch[k];
    if (patch.state_reason !== undefined) issue.state_reason = patch.state === "open" ? null : patch.state_reason;
    if (patch.labels !== undefined) issue.labels = patch.labels.map((name) => ({ name }));
    issue.updated_at = new Date().toISOString();
    return structuredClone(issue);
  }
  async listLabels() { return []; }
  async ensureLabels() { return []; }
}
