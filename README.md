# linkedin-agent

LinkedIn CLI tool for scraping posts, publishing, editing, and deleting — all from your terminal.

## Install

```bash
npm install -g linkedin-agent
```

Or run directly:

```bash
npx linkedin-agent
```

## Commands

### `get` — Scrape posts

Collects posts and engagement metrics (likes, comments, shares) via browser automation.

```bash
# Scrape your own posts
linkedin-agent get

# Scrape a specific profile
linkedin-agent get -p https://www.linkedin.com/in/someone

# Limit to recent 10 posts
linkedin-agent get -l 10

# Specify output directory
linkedin-agent get -o ./data
```

On first run, a browser window opens for LinkedIn login. The session persists across runs.

Repeated runs on the same day **merge** with existing data (no duplicates).

**Options:**
| Flag | Description | Default |
|------|-------------|---------|
| `-p, --profile <url>` | Target profile URL | Your profile |
| `-l, --limit <n>` | Max posts to collect | All |
| `-o, --output <dir>` | Output directory | Current directory |
| `-m, --max-scrolls <n>` | Max scroll iterations | 100 |

### `auth` — Set up OAuth

Required for `post`, `edit`, and `delete` commands.

```bash
# Auto: creates a Developer App + OAuth in one step
linkedin-agent auth

# Manual: use existing app credentials
linkedin-agent auth --client-id YOUR_ID --client-secret YOUR_SECRET
```

### `post` — Publish a post

```bash
# Post inline text
linkedin-agent post -t "Hello LinkedIn!"

# Post from a file
linkedin-agent post -f ./post.md

# Post with a link attachment
linkedin-agent post -t "Check this out" --link https://example.com
```

### `edit` — Edit a post

```bash
linkedin-agent edit --id "urn:li:share:123456" -t "Updated content"
linkedin-agent edit --id "urn:li:share:123456" -f ./updated.md
```

### `delete` — Delete a post

```bash
linkedin-agent delete --id "urn:li:share:123456"
```

## Output Format

`get` saves posts as JSON:

```json
[
  {
    "id": "urn:li:activity:123456",
    "text": "Post content...",
    "publishedAt": "2w",
    "numLikes": 42,
    "numComments": 5,
    "numShares": 3,
    "url": "https://www.linkedin.com/feed/update/urn:li:activity:123456/"
  }
]
```

File naming: `posts_{username}_{date}.json`

## How It Works

- **`get`**: Uses Playwright to open a real browser, intercepts LinkedIn's internal Voyager API responses as you scroll, and extracts post data.
- **`post/edit/delete`**: Uses LinkedIn's official REST API with OAuth 2.0 authentication.

## Requirements

- Node.js 18+
- Chromium (auto-installed via Playwright on first run)

## License

ISC
