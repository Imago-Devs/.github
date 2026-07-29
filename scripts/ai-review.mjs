#!/usr/bin/env node
import { readFileSync } from "node:fs";

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  GITHUB_EVENT_PATH,
  GITHUB_EVENT_NAME,
  OPENROUTER_API_KEY,
  OPENROUTER_MODELS = "poolside/laguna-s-2.1:free,meta-llama/llama-3.1-8b-instruct:free",
} = process.env;

const MODELS = OPENROUTER_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
const MAX_DIFF_CHARS = 60_000;
const MAX_BODY_CHARS = 20_000;
const TIMEOUT_MS = 60_000;

const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
const [owner, repo] = GITHUB_REPOSITORY.split("/");

function trim(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "\n... (truncated)" : s;
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

function fetchTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function gh(path, { diff = false, ...opts } = {}) {
  return withRetry(async () => {
    const res = await fetchTimeout(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: diff ? "application/vnd.github.v3.diff" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    return res;
  });
}

async function askOpenRouter(system, user) {
  let lastErr;
  for (const model of MODELS) {
    try {
      return await withRetry(async () => {
        const res = await fetchTimeout("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`OpenRouter ${model} ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error(`OpenRouter ${model} returned no content`);
        return { content, model };
      }, { attempts: 2 });
    } catch (err) {
      lastErr = err;
      console.error(`Model ${model} failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error("No models configured");
}

async function findExistingComment(issueNumber, marker) {
  const res = await gh(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
  const comments = await res.json();
  return comments.find((c) => c.body?.startsWith(marker));
}

async function upsertComment(issueNumber, marker, body) {
  const fullBody = `${marker}\n${body}`;
  const existing = await findExistingComment(issueNumber, marker);
  if (existing) {
    await gh(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: fullBody }),
    });
  } else {
    await gh(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: fullBody }),
    });
  }
}

async function reviewPR() {
  const pr = event.pull_request;
  const diffRes = await gh(`/repos/${owner}/${repo}/pulls/${pr.number}`, { diff: true });
  const diff = trim(await diffRes.text(), MAX_DIFF_CHARS);
  if (!diff.trim()) return;

  const { content, model } = await askOpenRouter(
    "You are a senior code reviewer. Review this PR diff for bugs, security issues, and design problems. Be concise, use bullet points, reference file/line where possible. If nothing significant, say so briefly.",
    `PR: ${pr.title}\n\n${trim(pr.body, MAX_BODY_CHARS)}\n\nDiff:\n${diff}`
  );

  await upsertComment(pr.number, "<!-- ai-review:pr -->", `### 🤖 AI Review (${model})\n\n${content}`);
}

async function triageIssue() {
  const issue = event.issue;
  const { content, model } = await askOpenRouter(
    "You triage GitHub issues. Summarize the issue in 1-2 sentences, suggest labels (bug/feature/question/docs), and flag if it looks like a duplicate or needs more info. Be concise.",
    `Title: ${issue.title}\n\nBody:\n${trim(issue.body, MAX_BODY_CHARS)}`
  );
  await upsertComment(issue.number, "<!-- ai-review:issue -->", `### 🤖 AI Triage (${model})\n\n${content}`);
}

try {
  if (GITHUB_EVENT_NAME === "pull_request" || GITHUB_EVENT_NAME === "pull_request_target") {
    await reviewPR();
  } else if (GITHUB_EVENT_NAME === "issues") {
    await triageIssue();
  } else {
    console.error(`Unsupported event: ${GITHUB_EVENT_NAME}`);
  }
} catch (err) {
  console.error("AI review failed:", err);
  process.exitCode = 0; // never fail the caller repo's checks
}
