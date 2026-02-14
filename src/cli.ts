#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { getLinkedInPosts } from "./scraper";
import { authenticate, loadCredentials } from "./auth";
import { postToLinkedIn, editLinkedInPost, deleteLinkedInPost } from "./poster";
import { setupDevApp } from "./dev-app";

function printHelp() {
  console.log(`
Usage: linkedin-agent <command> [options]

LinkedIn 자동화 도구 - 게시글 수집, 작성, 수정, 삭제

Commands:
  get      게시글 수집
  post     게시글 작성
  auth     OAuth 인증 설정
  edit     게시글 수정
  delete   게시글 삭제

Run 'linkedin-agent <command> --help' for command-specific options.
`);
}

function printGetHelp() {
  console.log(`
Usage: linkedin-agent get [options]

게시글과 반응 데이터를 수집합니다.

Options:
  -p, --profile <url>      대상 프로필 URL (기본: 내 프로필)
  -l, --limit <n>          최근 게시글 N개만 수집
  -o, --output <dir>       출력 디렉토리 (기본: 현재 디렉토리)
  -m, --max-scrolls <n>    최대 스크롤 횟수 (기본: 100)
  -h, --help               도움말 출력

Examples:
  linkedin-agent get                                          내 게시글 수집
  linkedin-agent get -p https://www.linkedin.com/in/someone   특정 프로필 게시글 수집
  linkedin-agent get -l 10                                    최근 10개만 수집
`);
}

function printPostHelp() {
  console.log(`
Usage: linkedin-agent post [options]

LinkedIn에 새 게시글을 작성합니다.

Options:
  -t, --text <text>        게시글 내용
  -f, --file <path>        파일에서 게시글 내용 읽기
  --link <url>             링크 첨부
  -h, --help               도움말 출력

Examples:
  linkedin-agent post -t "오늘의 게시글입니다."
  linkedin-agent post -f ./post.md
  linkedin-agent post -t "내용" --link https://example.com
`);
}

function printAuthHelp() {
  console.log(`
Usage: linkedin-agent auth [options]

LinkedIn OAuth 인증을 설정합니다.

인자 없이 실행하면 Developer App 자동 생성 → OAuth 인증까지 한번에 진행합니다.
이미 Developer App이 있다면 --client-id, --client-secret 옵션으로 바로 인증합니다.

Options:
  --client-id <id>         LinkedIn App Client ID (수동 모드)
  --client-secret <secret> LinkedIn App Client Secret (수동 모드)
  --company-page <url>     LinkedIn Company Page URL (자동 모드, 기본: https://www.linkedin.com/company/103290544/)
  -h, --help               도움말 출력

Examples:
  linkedin-agent auth                                          자동: App 생성 + OAuth
  linkedin-agent auth --client-id 86xxx --client-secret WPL_xxx  수동: 기존 App으로 OAuth
  linkedin-agent auth --company-page https://www.linkedin.com/company/12345/
`);
}

function parseGetArgs(args: string[]): { output: string; maxScrolls: number; profile?: string; limit?: number } {
  let output = process.cwd();
  let maxScrolls = 100;
  let profile: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-h":
      case "--help":
        printGetHelp();
        process.exit(0);
      case "-p":
      case "--profile":
        profile = args[++i];
        if (!profile) {
          console.error("Error: --profile requires a LinkedIn profile URL");
          process.exit(1);
        }
        break;
      case "-l":
      case "--limit":
        limit = parseInt(args[++i], 10);
        if (isNaN(limit) || limit <= 0) {
          console.error("Error: --limit requires a positive number");
          process.exit(1);
        }
        break;
      case "-o":
      case "--output":
        output = args[++i];
        if (!output) {
          console.error("Error: --output requires a directory path");
          process.exit(1);
        }
        break;
      case "-m":
      case "--max-scrolls":
        maxScrolls = parseInt(args[++i], 10);
        if (isNaN(maxScrolls) || maxScrolls <= 0) {
          console.error("Error: --max-scrolls requires a positive number");
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printGetHelp();
        process.exit(1);
    }
  }

  return { output, maxScrolls, profile, limit };
}

function parsePostArgs(args: string[]): { text?: string; file?: string; link?: string } {
  let text: string | undefined;
  let file: string | undefined;
  let link: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-h":
      case "--help":
        printPostHelp();
        process.exit(0);
      case "-t":
      case "--text":
        text = args[++i];
        if (!text) {
          console.error("Error: --text requires content");
          process.exit(1);
        }
        break;
      case "-f":
      case "--file":
        file = args[++i];
        if (!file) {
          console.error("Error: --file requires a file path");
          process.exit(1);
        }
        break;
      case "--link":
        link = args[++i];
        if (!link) {
          console.error("Error: --link requires a URL");
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printPostHelp();
        process.exit(1);
    }
  }

  return { text, file, link };
}

function parseAuthArgs(args: string[]): { clientId?: string; clientSecret?: string; companyPage?: string } {
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let companyPage: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-h":
      case "--help":
        printAuthHelp();
        process.exit(0);
      case "--client-id":
        clientId = args[++i];
        if (!clientId) {
          console.error("Error: --client-id requires a value");
          process.exit(1);
        }
        break;
      case "--client-secret":
        clientSecret = args[++i];
        if (!clientSecret) {
          console.error("Error: --client-secret requires a value");
          process.exit(1);
        }
        break;
      case "--company-page":
        companyPage = args[++i];
        if (!companyPage) {
          console.error("Error: --company-page requires a LinkedIn Company Page URL");
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printAuthHelp();
        process.exit(1);
    }
  }

  return { clientId, clientSecret, companyPage };
}

async function handleAuth(args: string[]) {
  const opts = parseAuthArgs(args);

  // Manual mode: client credentials provided → just run OAuth
  if (opts.clientId && opts.clientSecret) {
    await authenticate(opts.clientId, opts.clientSecret);
    console.log("\n✅ Auth successful. Credentials saved.");
    return;
  }

  // Auto mode: create Developer App via Playwright → OAuth in same browser
  console.log("\n🚀 Auto-creating LinkedIn Developer App...\n");

  const { launchBrowser } = await import("./browser");
  const logoPath = path.join(__dirname, "..", "assets", "default-logo.png");

  const context = await launchBrowser();

  try {
    const devApp = await setupDevApp(context, logoPath, opts.companyPage);

    console.log("🔐 Starting OAuth flow...\n");
    const page = context.pages()[0] || (await context.newPage());
    await authenticate(devApp.clientId, devApp.clientSecret, async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    });

    console.log("\n✅ Auth successful. Credentials saved.");
    console.log(`  App ID: ${devApp.appId}`);
    console.log(`  Client ID: ${devApp.clientId}`);
  } finally {
    await context.close();
  }
}

async function handlePost(args: string[]) {
  const opts = parsePostArgs(args);

  // Check authentication
  if (!loadCredentials()) {
    console.error("❌ Authentication required. Run 'linkedin-agent auth' first.");
    console.error("   You need a LinkedIn Developer App: https://developer.linkedin.com");
    process.exit(1);
  }

  // Resolve post text
  let text: string;
  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      console.error(`Error: File not found: ${opts.file}`);
      process.exit(1);
    }
    text = fs.readFileSync(opts.file, "utf-8").trim();
  } else if (opts.text) {
    text = opts.text;
  } else {
    console.error("Error: Provide post content with -t or -f.");
    printPostHelp();
    process.exit(1);
  }

  console.log(`\n📝 Posting to LinkedIn (${text.length} chars)...`);
  if (opts.link) {
    console.log(`🔗 Link: ${opts.link}`);
  }

  const result = await postToLinkedIn({ text, linkUrl: opts.link });

  if (result.success) {
    console.log(`\n✅ Posted successfully!`);
    if (result.postId) {
      console.log(`   Post ID: ${result.postId}`);
    }
  } else {
    console.error(`\n❌ Failed to post: ${result.error}`);
    process.exit(1);
  }
}

function printEditHelp() {
  console.log(`
Usage: linkedin-agent edit [options]

기존 LinkedIn 게시글의 텍스트를 수정합니다.
(링크, 이미지 등 첨부는 수정 불가 — LinkedIn API 제한)

Options:
  --id <post-id>           수정할 게시글 ID (urn:li:share:... 형식)
  -t, --text <text>        새 게시글 내용
  -f, --file <path>        파일에서 새 게시글 내용 읽기
  -h, --help               도움말 출력

Examples:
  linkedin-agent edit --id "urn:li:share:123456" -t "수정된 내용"
  linkedin-agent edit --id "urn:li:share:123456" -f ./updated.md
`);
}

function parseEditArgs(args: string[]): { postId?: string; text?: string; file?: string } {
  let postId: string | undefined;
  let text: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-h":
      case "--help":
        printEditHelp();
        process.exit(0);
      case "--id":
        postId = args[++i];
        if (!postId) {
          console.error("Error: --id requires a post ID");
          process.exit(1);
        }
        break;
      case "-t":
      case "--text":
        text = args[++i];
        if (!text) {
          console.error("Error: --text requires content");
          process.exit(1);
        }
        break;
      case "-f":
      case "--file":
        file = args[++i];
        if (!file) {
          console.error("Error: --file requires a file path");
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printEditHelp();
        process.exit(1);
    }
  }

  return { postId, text, file };
}

async function handleEdit(args: string[]) {
  const opts = parseEditArgs(args);

  if (!loadCredentials()) {
    console.error("❌ Authentication required. Run 'linkedin-agent auth' first.");
    process.exit(1);
  }

  if (!opts.postId) {
    console.error("Error: --id is required.");
    printEditHelp();
    process.exit(1);
  }

  let text: string;
  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      console.error(`Error: File not found: ${opts.file}`);
      process.exit(1);
    }
    text = fs.readFileSync(opts.file, "utf-8").trim();
  } else if (opts.text) {
    text = opts.text;
  } else {
    console.error("Error: Provide new content with -t or -f.");
    printEditHelp();
    process.exit(1);
  }

  console.log(`\n✏️ Editing post ${opts.postId} (${text.length} chars)...`);

  const result = await editLinkedInPost({ postId: opts.postId, text });

  if (result.success) {
    console.log(`\n✅ Post updated successfully!`);
  } else {
    console.error(`\n❌ Failed to edit: ${result.error}`);
    process.exit(1);
  }
}

function printDeleteHelp() {
  console.log(`
Usage: linkedin-agent delete [options]

LinkedIn 게시글을 삭제합니다.

Options:
  --id <post-id>           삭제할 게시글 ID (urn:li:share:... 형식)
  -h, --help               도움말 출력

Examples:
  linkedin-agent delete --id "urn:li:share:123456"
`);
}

function parseDeleteArgs(args: string[]): { postId?: string } {
  let postId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-h":
      case "--help":
        printDeleteHelp();
        process.exit(0);
      case "--id":
        postId = args[++i];
        if (!postId) {
          console.error("Error: --id requires a post ID");
          process.exit(1);
        }
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printDeleteHelp();
        process.exit(1);
    }
  }

  return { postId };
}

async function handleDelete(args: string[]) {
  const opts = parseDeleteArgs(args);

  if (!loadCredentials()) {
    console.error("❌ Authentication required. Run 'linkedin-agent auth' first.");
    process.exit(1);
  }

  if (!opts.postId) {
    console.error("Error: --id is required.");
    printDeleteHelp();
    process.exit(1);
  }

  console.log(`\n🗑️ Deleting post ${opts.postId}...`);

  const result = await deleteLinkedInPost(opts.postId);

  if (result.success) {
    console.log(`\n✅ Post deleted successfully!`);
  } else {
    console.error(`\n❌ Failed to delete: ${result.error}`);
    process.exit(1);
  }
}

const command = process.argv[2];
const commandArgs = process.argv.slice(3);

switch (command) {
  case "get":
    const getOpts = parseGetArgs(commandArgs);
    getLinkedInPosts(getOpts).catch((err) => {
      console.error("❌ Error:", err);
      process.exit(1);
    });
    break;

  case "post":
    handlePost(commandArgs).catch((err) => {
      console.error("❌ Error:", err);
      process.exit(1);
    });
    break;

  case "auth":
    handleAuth(commandArgs).catch((err) => {
      console.error("❌ Error:", err);
      process.exit(1);
    });
    break;

  case "edit":
    handleEdit(commandArgs).catch((err) => {
      console.error("❌ Error:", err);
      process.exit(1);
    });
    break;

  case "delete":
    handleDelete(commandArgs).catch((err) => {
      console.error("❌ Error:", err);
      process.exit(1);
    });
    break;

  case "-h":
  case "--help":
  case undefined:
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
