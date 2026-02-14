import * as https from "https";
import * as http from "http";
import { getValidCredentials, refreshAccessToken, type Credentials } from "./auth";

export interface PostOptions {
  text: string;
  linkUrl?: string;
}

export interface EditOptions {
  postId: string;
  text: string;
}

export interface PostResult {
  success: boolean;
  postId?: string;
  error?: string;
}

function httpsRequest(
  url: string,
  data: string,
  headers: Record<string, string>,
  method = "POST",
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqHeaders: Record<string, string | number> = { ...headers };
    if (data) {
      reqHeaders["Content-Length"] = Buffer.byteLength(data);
    }
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": "202601",
  };
}

async function withRetry(
  fn: (creds: Credentials) => Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>,
  onSuccess: (resp: { status: number; body: string; headers: http.IncomingHttpHeaders }) => PostResult,
): Promise<PostResult> {
  let creds = await getValidCredentials();
  let resp = await fn(creds);

  if (resp.status === 401) {
    console.log("Token expired. Refreshing...");
    creds = await refreshAccessToken(creds);
    resp = await fn(creds);
  }

  if (resp.status >= 200 && resp.status < 300) return onSuccess(resp);
  return { success: false, error: `HTTP ${resp.status}: ${resp.body}` };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function postToLinkedIn(options: PostOptions): Promise<PostResult> {
  return withRetry(
    (creds) => {
      const body: Record<string, unknown> = {
        author: `urn:li:person:${creds.personId}`,
        commentary: options.text,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };
      if (options.linkUrl) {
        body.content = { article: { source: options.linkUrl } };
      }
      return httpsRequest(
        "https://api.linkedin.com/rest/posts",
        JSON.stringify(body),
        makeHeaders(creds.accessToken),
      );
    },
    (resp) => ({ success: true, postId: (resp.headers["x-restli-id"] as string) || "" }),
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export async function editLinkedInPost(options: EditOptions): Promise<PostResult> {
  const encodedId = encodeURIComponent(options.postId);
  return withRetry(
    (creds) =>
      httpsRequest(
        `https://api.linkedin.com/rest/posts/${encodedId}`,
        JSON.stringify({ patch: { $set: { commentary: options.text } } }),
        makeHeaders(creds.accessToken),
        "POST",
      ),
    () => ({ success: true, postId: options.postId }),
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteLinkedInPost(postId: string): Promise<PostResult> {
  const encodedId = encodeURIComponent(postId);
  return withRetry(
    (creds) =>
      httpsRequest(
        `https://api.linkedin.com/rest/posts/${encodedId}`,
        "",
        makeHeaders(creds.accessToken),
        "DELETE",
      ),
    () => ({ success: true, postId }),
  );
}
