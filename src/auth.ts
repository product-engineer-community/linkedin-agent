import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

const CREDENTIALS_PATH = path.join(os.homedir(), ".linkedin-agent", "credentials.json");
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = "openid profile email w_member_social";

export interface Credentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  personId: string;
  expiresAt: number;
}

function httpsPost(
  url: string,
  data: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), "utf-8");
}

export function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export async function authenticate(
  clientId: string,
  clientSecret: string,
  openUrlFn?: (url: string) => Promise<void>,
): Promise<Credentials> {
  // 1. Start callback server and wait for authorization code
  const authCode = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "", "http://localhost:3000");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("Authentication complete! You can close this window.");
        resolve(code);
        server.close();
      } else if (error) {
        const desc = url.searchParams.get("error_description") || error;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`Error: ${desc}`);
        reject(new Error(`OAuth error: ${desc}`));
        server.close();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(3000, async () => {
      const authUrl =
        "https://www.linkedin.com/oauth/v2/authorization?" +
        new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          scope: SCOPES,
        }).toString();

      console.log("Opening browser for LinkedIn authentication...");
      console.log(`\nIf the browser doesn't open, visit this URL:\n${authUrl}\n`);

      if (openUrlFn) {
        await openUrlFn(authUrl);
      } else {
        exec(`open "${authUrl}"`);
      }
      console.log("Waiting for callback on localhost:3000...");
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });
  });

  console.log("Authorization code received.");

  // 2. Exchange code for tokens
  console.log("Exchanging code for tokens...");
  const tokenResp = await httpsPost(
    "https://www.linkedin.com/oauth/v2/accessToken",
    new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
    }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" },
  );

  const tokens = JSON.parse(tokenResp.body);
  if (!tokens.access_token) {
    throw new Error(`Token exchange failed: ${tokenResp.body}`);
  }
  console.log("Access token obtained.");

  // 3. Get person ID
  console.log("Fetching person ID...");
  const userResp = await httpsGet("https://api.linkedin.com/v2/userinfo", {
    Authorization: `Bearer ${tokens.access_token}`,
  });

  const userInfo = JSON.parse(userResp.body);
  const personId = userInfo.sub || "";
  if (!personId) {
    throw new Error("Could not retrieve person ID from userinfo.");
  }
  console.log(`Person ID: ${personId}`);

  // 4. Save credentials
  const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in || 5184000);
  const credentials: Credentials = {
    clientId,
    clientSecret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || "",
    personId,
    expiresAt,
  };

  saveCredentials(credentials);
  return credentials;
}

export async function refreshAccessToken(creds: Credentials): Promise<Credentials> {
  if (!creds.refreshToken) {
    throw new Error("No refresh token available. Run 'linkedin-agent auth' again.");
  }

  console.log("Refreshing access token...");
  const resp = await httpsPost(
    "https://www.linkedin.com/oauth/v2/accessToken",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" },
  );

  const tokens = JSON.parse(resp.body);
  if (!tokens.access_token) {
    throw new Error(`Token refresh failed: ${resp.body}`);
  }

  const updated: Credentials = {
    ...creds,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || creds.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 5184000),
  };

  saveCredentials(updated);
  console.log("Token refreshed successfully.");
  return updated;
}

export async function getValidCredentials(): Promise<Credentials> {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error("No credentials found. Run 'linkedin-agent auth' first.");
  }

  // Refresh if expiring within 1 day
  const oneDayFromNow = Math.floor(Date.now() / 1000) + 86400;
  if (creds.expiresAt < oneDayFromNow) {
    return refreshAccessToken(creds);
  }

  return creds;
}
