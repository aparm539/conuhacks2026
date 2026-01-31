/**
 * GitHub PR context discovery: resolve owner, repo, pull number, and commit SHA
 * from the workspace (Git API or CLI) and optional config overrides.
 */
import * as vscode from "vscode";
import { execSync } from "child_process";
import { GITHUB_API } from "./githubAuth";

export interface PrContext {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

function getConfigOverrides(): {
  owner?: string;
  repo?: string;
  pullNumber?: number;
} {
  const config = vscode.workspace.getConfiguration("pr-notes");
  const owner = config.get<string>("owner");
  const repo = config.get<string>("repo");
  const pullNumber = config.get<number>("pullNumber");
  return {
    owner: (owner && owner.trim()) || undefined,
    repo: (repo && repo.trim()) || undefined,
    pullNumber:
      typeof pullNumber === "number" && pullNumber > 0 ? pullNumber : undefined,
  };
}

/**
 * Parse GitHub remote URL into owner and repo.
 * Supports https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git].
 */
export function parseRemoteUrl(
  url: string,
): { owner: string; repo: string } | null {
  if (!url || typeof url !== "string") {
    return null;
  }
  const trimmed = url.trim();
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/i.exec(
    trimmed,
  );
  if (https) {
    return { owner: https[1], repo: https[2].replace(/\.git$/, "") };
  }
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/i.exec(trimmed);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2].replace(/\.git$/, "") };
  }
  return null;
}

interface GitInfo {
  remoteUrl: string;
  branch: string;
  root: string;
}

function getGitInfoFromApi(root: string): GitInfo | null {
  try {
    const ext = vscode.extensions.getExtension<{
      getAPI: (v: number) => unknown;
    }>("vscode.git");
    if (!ext?.isActive) {
      return null;
    }
    type GitRepo = {
      rootUri: { fsPath: string };
      state?: {
        HEAD?: { name?: string };
        remotes?: { name?: string; fetchUrl?: string }[];
      };
    };
    const api = ext.exports?.getAPI(1) as
      | { repositories?: GitRepo[] }
      | undefined;
    if (!api?.repositories?.length) {
      return null;
    }
    const repo =
      api.repositories.find((r: GitRepo) => {
        const rp = r.rootUri.fsPath;
        return (
          root === rp || root.startsWith(rp + "/") || rp.startsWith(root + "/")
        );
      }) ?? api.repositories[0];
    const rootPath = repo.rootUri.fsPath;
    const head = repo.state?.HEAD?.name;
    const remotes = repo.state?.remotes;
    const origin = remotes?.find((r) => r.name === "origin");
    const fetchUrl = origin?.fetchUrl ?? remotes?.[0]?.fetchUrl;
    if (!fetchUrl || !head) {
      return null;
    }
    return { remoteUrl: fetchUrl, branch: head, root: rootPath };
  } catch {
    return null;
  }
}

function getGitInfoFromCli(root: string): GitInfo | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf8",
      cwd: root,
    }).trim();
    const branch = execSync("git branch --show-current", {
      encoding: "utf8",
      cwd: root,
    }).trim();
    if (!remoteUrl || !branch) {
      return null;
    }
    return { remoteUrl, branch, root };
  } catch {
    return null;
  }
}

async function fetchOpenPrForBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ number: number; headSha: string } | null> {
  const head = `${owner}:${branch}`;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as {
    number: number;
    head?: { sha?: string };
  }[];
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const pr = data[0];
  const headSha = pr.head?.sha;
  if (!headSha) {
    return null;
  }
  return { number: pr.number, headSha };
}

async function fetchPrDetails(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pullNumber}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { head?: { sha?: string } };
  return data.head?.sha ?? null;
}

/**
 * Resolve PR context: owner, repo, pull number, and commit SHA.
 * Uses config overrides (pr-notes.owner, repo, pullNumber) when set; otherwise
 * discovers from Git (VS Code Git API or git CLI) and GitHub API.
 *
 * @param token - GitHub token (e.g. from getSession). Required for API calls when
 *                not using full config overrides, and for fetching commitId when using overrides.
 * @returns PrContext or null if resolution fails.
 */
export async function getPrContext(
  token: string | undefined,
): Promise<PrContext | null> {
  const overrides = getConfigOverrides();

  if (overrides.owner && overrides.repo && overrides.pullNumber) {
    const commitId = token
      ? await fetchPrDetails(
          token,
          overrides.owner,
          overrides.repo,
          overrides.pullNumber,
        )
      : null;
    if (!commitId) {
      return null;
    }
    return {
      owner: overrides.owner,
      repo: overrides.repo,
      pullNumber: overrides.pullNumber,
      commitId,
    };
  }

  const root = getWorkspaceRoot();
  if (!root) {
    return null;
  }

  const git = getGitInfoFromApi(root) ?? getGitInfoFromCli(root);
  if (!git) {
    return null;
  }

  const parsed = parseRemoteUrl(git.remoteUrl);
  if (!parsed) {
    return null;
  }

  const owner = overrides.owner ?? parsed.owner;
  const repo = overrides.repo ?? parsed.repo;

  if (!token) {
    return null;
  }

  if (overrides.pullNumber) {
    const commitId = await fetchPrDetails(
      token,
      owner,
      repo,
      overrides.pullNumber,
    );
    if (!commitId) {
      return null;
    }
    return { owner, repo, pullNumber: overrides.pullNumber, commitId };
  }

  const pr = await fetchOpenPrForBranch(token, owner, repo, git.branch);
  if (!pr) {
    return null;
  }

  return {
    owner,
    repo,
    pullNumber: pr.number,
    commitId: pr.headSha,
  };
}
