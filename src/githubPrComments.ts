/**
 * Post PR review comments to GitHub via the REST API.
 */
import type { PrContext } from './gitHubPrContext';

const GITHUB_API = 'https://api.github.com';

export interface ReviewCommentInput {
	path: string;
	line: number;
	body: string;
}

export interface PostReviewResult {
	success: boolean;
	error?: string;
}

/**
 * Create a pull request review with the given line-level comments.
 * Uses POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews.
 *
 * @param comments - Array of { path, line, body }. path is repo-relative; line is 1-based.
 * @param ctx - PR context from getPrContext.
 * @param token - GitHub access token (e.g. session.accessToken).
 * @returns Success or error message.
 */
export async function postReviewComments(
	comments: ReviewCommentInput[],
	ctx: PrContext,
	token: string
): Promise<PostReviewResult> {
	if (comments.length === 0) {
		return { success: true };
	}

	const url = `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.pullNumber}/reviews`;
	const body = {
		commit_id: ctx.commitId,
		event: 'COMMENT' as const,
		comments: comments.map((c) => ({
			path: c.path,
			line: c.line,
			body: c.body,
		})),
	};

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/vnd.github.v3+json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});

		if (res.ok) {
			return { success: true };
		}

		const text = await res.text();
		let error: string;
		try {
			const json = JSON.parse(text) as { message?: string; errors?: unknown };
			error = json.message ?? text;
		} catch {
			error = text || `HTTP ${res.status}`;
		}

		if (res.status === 401) {
			error = 'GitHub authentication failed. Please sign in again.';
		} else if (res.status === 403) {
			error = 'Permission denied or rate limited. Check token scope and rate limits.';
		} else if (res.status === 422) {
			error = 'Cannot add review comments (e.g. file/lines not in PR diff). ' + (error || '');
		}

		return { success: false, error };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { success: false, error: `Failed to post to GitHub: ${msg}` };
	}
}
